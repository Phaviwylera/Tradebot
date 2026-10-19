#!/usr/bin/env python3
"""Opus Agent Desk — entry point.

Examples
--------
    python main.py                     # run once on the fixture board, save reports
    python main.py --source live       # run once on read-only public data
    python main.py --serve             # dashboard at http://localhost:8765
    python main.py --serve --port 9000 --open
    python main.py --json              # print the full run as JSON
    python main.py --build-fixtures    # regenerate data/fixtures.json

Paper only. No wallet, key, signing or order endpoint exists in this project.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from tools.desk import __version__, data
from tools.desk.config import ConfigError, load_config, summary_lines
from tools.desk.pipeline import PipelineError, run_pipeline


def _print_summary(run: dict) -> None:
    boss = run["reports"]["boss"]
    meta = boss.get("meta") or {}
    counts = meta.get("counts") or {}
    print()
    print(f"Opus Agent Desk {__version__} — run {run['run_id']}")
    print("=" * 66)
    for line in summary_lines(load_config()):
        print(f"  {line}")
    print("-" * 66)
    print(f"  universe      : {run['universe']['size']} markets "
          f"({'synthetic' if run['universe']['synthetic'] else 'live'})")
    print(f"  watchlist     : {len(run['reports']['scout']['evidence'])}")
    print(f"  plans         : {counts.get('plans', 0)}  (WAIT: {counts.get('waits', 0)})")
    print(f"  risk cleared  : {counts.get('risk_passed', 0)}  "
          f"(rejected: {counts.get('risk_rejected', 0)})")
    print(f"  halted at     : {run.get('halted_at') or '—'}")
    print("-" * 66)
    print(f"  DECISION      : {meta.get('decision')}")
    print(f"  {boss.get('summary')}")
    approved = meta.get("approved") or []
    if approved:
        print()
        print("  Approved paper plans")
        print("  " + "-" * 64)
        for trade in approved:
            print(f"  {trade['question'][:44]:44} {trade['side'][:10]:10} "
                  f"entry {trade['entry']:.3f} stop {trade['invalidation']:.3f} "
                  f"target {trade['target']:.3f}")
            print(f"    {trade['shares']} shares · risk ${trade['risk_dollars']:.2f} · "
                  f"net R:R {trade['net_rr']:.2f} · limit {trade['time_limit_utc']}")
    files = run.get("files") or {}
    if files:
        print()
        print(f"  report: {files.get('json')}")
        print(f"  summary: {files.get('markdown')}")
    print()
    print("  Paper only. A clean run does not prove an edge.")
    print()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opus-agent-desk",
        description="Six-agent paper-trading research desk. No order execution.",
    )
    parser.add_argument("--config", default=None, help="path to config.yaml")
    parser.add_argument("--source", choices=("fixture", "test", "live"), default=None,
                        help="override data.source for this run")
    parser.add_argument("--json", action="store_true", help="print the full run JSON to stdout")
    parser.add_argument("--serve", action="store_true", help="serve the dashboard and API")
    parser.add_argument("--host", default="0.0.0.0", help="server bind address")
    parser.add_argument("--port", type=int, default=8765, help="server port")
    parser.add_argument("--open", action="store_true", help="open a browser when serving")
    parser.add_argument("--build-fixtures", action="store_true",
                        help="regenerate data/fixtures.json from the seeded generator")
    parser.add_argument("--seed", type=int, default=20261019, help="fixture generator seed")
    parser.add_argument("--port-check", action="store_true", help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.build_fixtures:
        payload = data.build_fixtures(data.now_ms(), args.seed, "data/fixtures.json")
        print(f"Wrote data/fixtures.json with {len(payload['markets'])} synthetic markets "
              f"(seed {args.seed}, label {payload['label']}).")
        return 0

    try:
        overrides: dict[str, object] = {}
        if args.source:
            overrides["source"] = args.source
        if args.seed:
            overrides["test_seed"] = args.seed
        cfg = load_config(args.config, overrides or None)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    if args.serve:
        from tools.desk.server import serve

        serve(args.config, host=args.host, port=args.port, open_browser=args.open)
        return 0

    try:
        run = run_pipeline(cfg)
    except PipelineError as exc:
        print(f"Pipeline validation failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - CLI must exit with a readable message
        print(f"Run failed: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(run, indent=2))
    else:
        _print_summary(run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
