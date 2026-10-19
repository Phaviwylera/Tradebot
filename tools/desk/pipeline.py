"""Pipeline runner, schema validation and report persistence.

The runner is the only thing that moves data between stages. It:
  1. loads config.yaml and enforces paper-only,
  2. runs Scout -> News -> Charts -> Strategy -> Risk -> Boss in order,
  3. stops the chain when a stage returns needs_data or rejected,
  4. validates every report against the shared envelope,
  5. saves a timestamped JSON run, a Markdown summary, latest.json and index.json.

No stage can skip another, and the Boss cannot run before Risk.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import __version__
from . import agents, data, ledger
from .config import ROOT, Config

PIPELINE_ERROR = "PipelineError"
Decision = str
Progress = Callable[[dict[str, Any]], None] | None


class PipelineError(RuntimeError):
    """Raised when a run cannot be completed or a report fails validation."""


# --------------------------------------------------------------------------- #
# schema
# --------------------------------------------------------------------------- #

def validate_report(report: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(report, dict):
        return ["report is not an object"]
    if not report.get("agent"):
        errors.append("missing agent")
    stamp = report.get("timestamp_utc")
    if not stamp:
        errors.append("missing or invalid timestamp_utc")
    else:
        try:
            datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        except ValueError:
            errors.append("missing or invalid timestamp_utc")
    if report.get("status") not in agents.REPORT_STATUSES:
        errors.append(f"invalid status: {report.get('status')}")
    summary = report.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        errors.append("missing summary")
    if not isinstance(report.get("evidence"), list):
        errors.append("evidence must be an array")
    if not isinstance(report.get("risks"), list):
        errors.append("risks must be an array")
    if not isinstance(report.get("next_step"), str):
        errors.append("missing next_step")
    if report.get("agent") == "boss":
        decision = (report.get("meta") or {}).get("decision")
        if decision not in agents.BOSS_DECISIONS:
            errors.append(f"boss decision must be one of {', '.join(agents.BOSS_DECISIONS)}")
    return errors


def validate_run(run: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(run, dict):
        return ["run is not an object"]
    for key in ("run_id", "started_utc", "finished_utc", "reports"):
        if not run.get(key):
            errors.append(f"missing {key}")
    reports = run.get("reports")
    if not isinstance(reports, dict):
        return errors + ["reports must be an object"]
    for name, report in reports.items():
        for error in validate_report(report):
            errors.append(f"{name}: {error}")
    boss = reports.get("boss")
    decision = ((boss or {}).get("meta") or {}).get("decision")
    if decision not in agents.BOSS_DECISIONS:
        errors.append("run has no valid Boss decision")
    config = run.get("config") or {}
    if config.get("mode") != "paper" or config.get("allow_live_orders") is not False:
        errors.append("run is not in paper mode")
    if config.get("allow_live_orders") is not False:
        errors.append("run allows live orders")
    return errors


# --------------------------------------------------------------------------- #
# persistence
# --------------------------------------------------------------------------- #

def _report_dir(cfg: Config) -> Path:
    path = Path(cfg.report_dir)
    return path if path.is_absolute() else ROOT / path


def _public_dir() -> Path:
    return ROOT / "public"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _run_id(started_ms: int, source: str, directory: Path) -> str:
    base = datetime.fromtimestamp(started_ms / 1000, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = f"{base}-{source}"
    suffix = 2
    while (directory / f"{candidate}.json").exists():
        candidate = f"{base}-{source}-{suffix}"
        suffix += 1
    return candidate


PUBLIC_RUN_LIMIT = 5
_RUN_FILE = re.compile(r"^\d{8}T\d{6}Z-(fixture|test|live)(-\d+)?\.json$")


def save_run(run: dict[str, Any], cfg: Config) -> dict[str, str]:
    directory = _report_dir(cfg)
    directory.mkdir(parents=True, exist_ok=True)
    run_id = run["run_id"]
    payload = json.dumps(run, indent=2)
    json_path = directory / f"{run_id}.json"
    _atomic_write(json_path, payload + "\n")
    _atomic_write(directory / "latest.json", payload + "\n")
    _atomic_write(directory / f"{run_id}.md", render_markdown(run))

    index_path = directory / "index.json"
    index = load_index(cfg)
    runs = [entry for entry in index.get("runs", []) if entry.get("run_id") != run_id]
    runs.insert(0, run_index_entry(run))
    index = {"updated_at": run["finished_utc"], "runs": runs[:30]}
    _atomic_write(index_path, json.dumps(index, indent=2) + "\n")

    # Copies for static hosting (Vercel/GitHub Pages), where no API exists. The local file
    # paths are stripped: they mean nothing outside this machine and should not be published.
    if cfg.public_copy:
        public_reports = _public_dir() / "reports"
        public_run = {key: value for key, value in run.items() if key != "files"}
        _atomic_write(public_reports / "latest.json", json.dumps(public_run, indent=2) + "\n")

        # Publish the newest runs so the static dashboard can browse history too.
        published: list[dict[str, Any]] = []
        names: set[str] = set()
        candidates = sorted(
            (path for path in directory.glob("*.json")
             if path.name not in ("index.json", "latest.json")),
            key=lambda path: path.stat().st_mtime, reverse=True)
        for path in candidates[:PUBLIC_RUN_LIMIT]:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(payload, dict) or "reports" not in payload:
                continue
            _atomic_write(public_reports / path.name,
                          json.dumps({k: v for k, v in payload.items() if k != "files"},
                                     indent=2) + "\n")
            names.add(path.name)
            published.append(run_index_entry(payload))

        # Remove snapshots that have aged out, so the folder does not grow without bound.
        for stale in public_reports.glob("*.json"):
            if stale.name in ("index.json", "latest.json") or stale.name in names:
                continue
            if _RUN_FILE.match(stale.name):
                stale.unlink(missing_ok=True)

        public_index = {"updated_at": run["finished_utc"], "runs": published}
        _atomic_write(public_reports / "index.json", json.dumps(public_index, indent=2) + "\n")
    return {"json": str(json_path), "markdown": str(directory / f"{run_id}.md")}


def run_index_entry(run: dict[str, Any]) -> dict[str, Any]:
    boss = run["reports"].get("boss") or {}
    meta = boss.get("meta") or {}
    risk = run["reports"].get("risk") or {}
    strategy = run["reports"].get("strategy") or {}
    return {
        "run_id": run["run_id"],
        "finished_utc": run["finished_utc"],
        "source": run.get("source", ""),
        "synthetic": bool((run.get("universe") or {}).get("synthetic")),
        "decision": meta.get("decision"),
        "approved": len(meta.get("approved") or []),
        "equity": (run.get("paper") or {}).get("equity"),
        "paper_pnl": (run.get("paper") or {}).get("total_pnl"),
        "open_positions": (run.get("paper") or {}).get("open_count"),
        "plans": (meta.get("counts") or {}).get("plans", 0),
        "risk_passed": (meta.get("counts") or {}).get("risk_passed", 0),
        "risk_rejected": (meta.get("counts") or {}).get("risk_rejected", 0),
        "waits": (meta.get("counts") or {}).get("waits", len(
            [item for item in (strategy.get("evidence") or []) if item.get("status") == "WAIT"])),
        "halted_at": run.get("halted_at"),
        "universe_size": (run.get("universe") or {}).get("size", 0),
        "duration_ms": run.get("duration_ms", 0),
        "risk_reviewed": len([item for item in (risk.get("evidence") or [])
                              if item.get("verdict") != "NOT_REVIEWED"]),
    }


def load_index(cfg: Config) -> dict[str, Any]:
    path = _report_dir(cfg) / "index.json"
    if not path.exists():
        return {"updated_at": None, "runs": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {"updated_at": None, "runs": []}
    if not isinstance(payload, dict):
        return {"updated_at": None, "runs": []}
    return payload


def load_latest(cfg: Config) -> dict[str, Any] | None:
    path = _report_dir(cfg) / "latest.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def load_run(cfg: Config, run_id: str) -> dict[str, Any] | None:
    if not run_id or "/" in run_id or ".." in run_id:
        return None
    path = _report_dir(cfg) / f"{run_id}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


# --------------------------------------------------------------------------- #
# markdown report
# --------------------------------------------------------------------------- #

def _cell(value: Any) -> str:
    return str(value if value is not None else "—").replace("|", "\\|").replace("\n", " ")


def render_markdown(run: dict[str, Any]) -> str:
    reports = run["reports"]
    boss = reports.get("boss") or {}
    meta = boss.get("meta") or {}
    decision = meta.get("decision", "UNKNOWN")
    lines = [
        f"# Opus Agent Desk — run {run['run_id']}",
        "",
        f"- **Final decision:** `{decision}`",
        f"- **Data source:** {run.get('source')} — {run.get('source_detail', '')}",
        f"- **Universe:** {run.get('universe', {}).get('size', 0)} markets"
        f" ({'synthetic' if run.get('universe', {}).get('synthetic') else 'live'})",
        f"- **Started / finished:** {run.get('started_utc')} → {run.get('finished_utc')}"
        f" ({run.get('duration_ms', 0)} ms)",
        f"- **Mode:** paper only · live orders disabled · human approval required",
        "",
        f"> {boss.get('summary', '')}",
        "",
    ]

    approved = meta.get("approved") or []
    if approved:
        lines += [
            "## Approved paper plans",
            "",
            "| Market | Side | Entry | Invalidation | Target | Shares | Risk | Net R:R | Time limit |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for trade in approved:
            lines.append(
                f"| {_cell(trade['question'])} | {_cell(trade['side'])} | {trade['entry']:.3f} | "
                f"{trade['invalidation']:.3f} | {trade['target']:.3f} | {trade['shares']} | "
                f"${trade['risk_dollars']:.2f} | {trade['net_rr']:.2f} | {trade['time_limit_utc']} |"
            )
        lines.append("")

    lines += ["## Stage reports", ""]
    for name in ("scout", "news", "charts", "strategy", "risk", "boss"):
        report = reports.get(name)
        if not report:
            lines.append(f"### {name.upper()} — not reached\n")
            continue
        lines.append(f"### {report.get('label', name.upper())} — `{report.get('status')}`")
        lines.append("")
        lines.append(report.get("summary", ""))
        lines.append("")
        records = report.get("evidence") or []
        if name == "risk":
            for item in records:
                if item.get("verdict") == "NOT_REVIEWED":
                    continue
                failed = [check["name"] for check in item.get("checks", []) if not check.get("pass")]
                lines.append(f"- **{item.get('verdict')}** — {item.get('question')}"
                             + (f" — failed: {', '.join(failed)}" if failed else ""))
        elif name == "strategy":
            for item in records:
                if item.get("status") == "plan":
                    lines.append(f"- **PLAN** — {item.get('question')} — {item.get('side')} — "
                                 f"entry {item.get('entry')} / stop {item.get('invalidation')} / "
                                 f"target {item.get('target')} — R:R {item.get('gross_rr')}")
                else:
                    lines.append(f"- WAIT — {item.get('question')} — {item.get('reason')}")
        else:
            for item in records[:12]:
                label = item.get("question") or item.get("market_id")
                extra = item.get("score")
                lines.append(f"- {label}" + (f" (score {extra})" if extra is not None else ""))
        risks = report.get("risks") or []
        if risks:
            lines.append("")
            lines.append("Flags:")
            for risk in risks[:10]:
                lines.append(f"- {risk}")
        lines.append("")

    lines += [
        "## Safety",
        "",
        "Paper only. No wallet, key, signing or order endpoint exists in this project. "
        "A successful run means the workflow completed safely; it does not mean the strategy is profitable.",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #

def session_timestamp(reference_ms: int | None = None) -> int:
    return reference_ms if reference_ms is not None else data.now_ms()


def run_pipeline(cfg: Config, *, reference_ms: int | None = None,
                 context: dict[str, Any] | None = None,
                 persist: bool = True,
                 progress: Progress = None) -> dict[str, Any]:
    """Run the six stages in order and return the validated run record."""
    started_ms = session_timestamp(reference_ms)
    clock = [started_ms]

    def now() -> int:
        if reference_ms is not None:
            return reference_ms
        clock[0] = data.now_ms()
        return clock[0]

    def emit(event: dict[str, Any]) -> None:
        if progress:
            progress(event)

    directory = _report_dir(cfg)
    run_id = _run_id(started_ms, cfg.source, directory)
    reports: dict[str, Any] = {}
    histories: dict[str, Any] = {}
    halted_at: str | None = None
    stage_ms: dict[str, int] = {}

    def stage_start() -> float:
        return time.perf_counter()

    def stage_end(name: str, started: float) -> None:
        stage_ms[name] = int((time.perf_counter() - started) * 1000)
        emit({"stage": name, "duration_ms": stage_ms[name],
              "status": (reports.get(name) or {}).get("status")})

    def fail_stage(name: str, message: str) -> None:
        reports[name] = agents.base_report(
            name, now(), "needs_data",
            f"Stage failed: {message}",
            [], [message],
            "Pipeline halted. Fix the input and re-run; no trade is approved.",
            {"error": message},
        )

    emit({"stage": "universe", "status": "loading"})
    universe_error: str | None = None
    try:
        universe, universe_meta = data.load_universe(cfg, now(), progress)
    except Exception as exc:  # noqa: BLE001 - missing data is a reportable state, not a crash
        universe, universe_error = [], describe_error(exc)
        universe_meta = {
            "source": cfg.source,
            "fetched_at": data.iso(started_ms),
            "note": f"universe load failed: {universe_error}",
            "synthetic": False,
            "label": "NO DATA",
        }
    emit({"stage": "universe", "status": "loaded" if not universe_error else "failed",
          "size": len(universe), "source": universe_meta.get("source"),
          **({"error": universe_error} if universe_error else {})})

    started = stage_start()
    if universe_error:
        reports["scout"] = agents.base_report(
            "scout", now(), "needs_data",
            f"Could not load the market universe: {universe_error}",
            [], [universe_error],
            "Fix the data source and re-run. No trade is approved without a universe.",
            {"error": universe_error, "source": cfg.source, "expected_source": cfg.source},
        )
    else:
        try:
            reports["scout"] = agents.run_scout(universe, universe_meta, cfg, now())
        except Exception as exc:  # noqa: BLE001 - a failed stage must halt, not crash silently
            fail_stage("scout", str(exc))
    stage_end("scout", started)
    if reports["scout"]["status"] != "complete" and cfg.stop_on_needs_data:
        halted_at = "scout"

    market_lookup = {market["id"]: market for market in universe}
    if not halted_at:
        started = stage_start()
        try:
            reports["news"] = agents.run_news(
                reports["scout"],
                lambda market_id: market_lookup.get(market_id),
                lambda market: data.fetch_news(cfg, market, now()),
                cfg, now(),
                on_market=lambda market_id, count: emit(
                    {"stage": "news", "market_id": market_id, "headlines": count}),
            )
        except Exception as exc:  # noqa: BLE001
            fail_stage("news", str(exc))
        stage_end("news", started)
        if reports["news"]["status"] != "complete" and cfg.stop_on_needs_data:
            halted_at = "news"

    if not halted_at:
        started = stage_start()
        covered = (reports["news"].get("meta") or {}).get("covered_market_ids", [])
        for market_id in covered[: cfg.history_limit]:
            market = market_lookup.get(market_id)
            try:
                histories[market_id] = data.fetch_history(cfg, market, now())
            except Exception as exc:  # noqa: BLE001 - one bad series must not stop the desk
                histories[market_id] = {"points": [], "error": str(exc),
                                        "source": "unavailable", "outcomes": market["outcomes"]}
            emit({"stage": "charts", "market_id": market_id,
                  "bars": len(histories[market_id].get("points", []))})
        try:
            reports["charts"] = agents.run_charts(reports["scout"], reports["news"],
                                                  histories, cfg, now())
        except Exception as exc:  # noqa: BLE001
            fail_stage("charts", str(exc))
        stage_end("charts", started)
        if reports["charts"]["status"] != "complete" and cfg.stop_on_needs_data:
            halted_at = "charts"

    if not halted_at:
        started = stage_start()
        try:
            reports["strategy"] = agents.run_strategy(reports["scout"], reports["news"],
                                                      reports["charts"], cfg, now())
        except Exception as exc:  # noqa: BLE001
            fail_stage("strategy", str(exc))
        stage_end("strategy", started)
        if reports["strategy"]["status"] != "complete" and cfg.stop_on_needs_data:
            halted_at = "strategy"

    book = None
    if cfg.source == "live" and cfg.paper_enabled:
        book = ledger.load_ledger(cfg, now())
        ledger.settle(book, universe, now())

    if not halted_at:
        started = stage_start()
        risk_context = context or {
            "bankroll": cfg.bankroll,
            "open_positions": (book or {}).get("positions") or [],
            "cash": (book or {}).get("cash", cfg.starting_cash),
        }
        try:
            reports["risk"] = agents.run_risk(
                reports["strategy"], reports["news"], reports["scout"], reports["charts"],
                risk_context, cfg, now())
        except Exception as exc:  # noqa: BLE001
            fail_stage("risk", str(exc))
        stage_end("risk", started)
        if reports["risk"]["status"] != "complete" and cfg.stop_on_needs_data:
            halted_at = "risk"

    started = stage_start()
    reports["boss"] = agents.run_boss(reports, cfg, now(), halted_at=halted_at, source=cfg.source)
    stage_end("boss", started)

    paper = None
    paper_files: dict[str, str] = {}
    paper_events: list[dict[str, Any]] = []
    if book is not None:
        opened = ledger.open_from_run(book, reports["boss"], now())
        equity = ledger.record_equity(book, now())
        paper = ledger.snapshot(book, now())
        paper["opened_this_run"] = [
            {"trade_id": entry.get("trade_id"), "market_id": entry.get("market_id"),
             "question": entry.get("question"), "side": entry.get("side"),
             "shares": entry.get("shares"), "entry": entry.get("entry"),
             "cost_basis": entry.get("cost_basis")}
            for entry in opened
        ]
        paper_files = ledger.save_ledger(cfg, book, now())
        paper_events = [{"stage": "paper", "event": "open", "trade_id": entry.get("trade_id"),
                         "market_id": entry.get("market_id")} for entry in opened]
        emit({"stage": "paper", "equity": equity, "cash": paper["cash"],
              "open_positions": paper["open_count"], "pnl": paper["total_pnl"]})

    errors = validate_run({
        "run_id": run_id,
        "started_utc": data.iso(started_ms),
        "finished_utc": data.iso(now()),
        "reports": reports,
        "config": {"mode": cfg.mode, "allow_live_orders": cfg.allow_live_orders},
    })
    if errors:
        raise PipelineError("report validation failed: " + "; ".join(errors))

    finished_ms = now()
    run = {
        "run_id": run_id,
        "desk_version": __version__,
        "mode": cfg.mode,
        "source": cfg.source,
        "source_label": universe_meta.get("label", ""),
        "source_detail": universe_meta.get("note", ""),
        "started_utc": data.iso(started_ms),
        "finished_utc": data.iso(finished_ms),
        "duration_ms": finished_ms - started_ms,
        "universe": {
            "size": len(universe),
            "fetched_at": universe_meta.get("fetched_at"),
            "synthetic": bool(universe_meta.get("synthetic")),
        },
        "config": cfg.public_dict(),
        "contracts": data.contract_hashes(cfg.contracts_dir),
        "stage_ms": stage_ms,
        "reports": reports,
        "halted_at": halted_at,
        "boss": reports["boss"],
    }
    if paper is not None:
        run["paper"] = paper
    run["validation"] = {"ok": True, "errors": []}

    if paper_files:
        run.setdefault("files", {}).update(paper_files)
    if persist:
        run["files"] = {**run.get("files", {}), **save_run(run, cfg)}
        emit({"stage": "saved", **run["files"]})
    emit({"stage": "done", "decision": run["boss"]["meta"]["decision"],
          "run_id": run["run_id"]})
    return run


def describe_error(exc: BaseException) -> str:
    return f"{exc.__class__.__name__}: {exc}" if str(exc) else exc.__class__.__name__


def safe_run(cfg: Config, **kwargs: Any) -> tuple[dict[str, Any] | None, str | None]:
    """Run the pipeline and convert unexpected failures into a message for the caller."""
    try:
        return run_pipeline(cfg, **kwargs), None
    except Exception as exc:  # noqa: BLE001 - the server must answer, not crash
        traceback.print_exc()
        return None, describe_error(exc)
