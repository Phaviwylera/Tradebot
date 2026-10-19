"""Configuration loading and hard safety rules.

`config.yaml` is the single source of truth. The loader refuses anything that is not paper mode,
and the two safety fields cannot be enabled from the dashboard or the API.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .yamlish import YamlSubsetError, safe_load as load_yaml_subset

try:  # PyYAML is optional; the shipped config stays inside the supported subset.
    import yaml as _yaml
except ModuleNotFoundError:  # pragma: no cover - exercised on bare installs
    _yaml = None

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = ROOT / "config.yaml"
VALID_SOURCES = ("fixture", "test", "live")


class ConfigError(RuntimeError):
    """Raised when the configuration would break a safety rule or is malformed."""


@dataclass(frozen=True)
class Config:
    # safety
    mode: str = "paper"
    allow_live_orders: bool = False
    # data
    source: str = "fixture"
    fixture_file: str = "data/fixtures.json"
    gamma_base: str = "https://gamma-api.polymarket.com"
    clob_base: str = "https://clob.polymarket.com"
    news_base: str = "https://news.google.com/rss/search"
    universe_limit: int = 500
    page_size: int = 100
    request_timeout_s: int = 15
    retries: int = 1
    test_seed: int = 20261019
    # scan
    shortlist_size: int = 10
    min_universe_size: int = 20
    min_liquidity: float = 2000
    max_spread: float = 0.05
    min_minutes_to_resolution: int = 10
    activity_floor: int = 8
    # news
    require_news: bool = True
    max_items: int = 8
    max_headline_age_hours: float = 24
    news_freshness_minutes: int = 180
    # charts
    interval: str = "1d"
    fidelity_minutes: int = 15
    min_history_points: int = 12
    chart_freshness_minutes: int = 60
    # strategy
    min_net_rr: float = 1.5
    max_stop_distance: float = 0.12
    max_entry_distance: float = 0.12
    max_pullback_distance: float = 0.05
    time_limit_hours: int = 6
    # risk
    bankroll: float = 1000
    max_positions: int = 5
    max_total_exposure_pct: float = 25
    max_position_risk_pct: float = 2
    max_daily_risk_pct: float = 6
    max_per_category: int = 2
    max_per_event: int = 1
    cost_buffer_pct: float = 2
    min_reward_to_spread: float = 3
    watchlist_freshness_minutes: int = 30
    event_risk_high: str = "block"
    event_risk_medium: str = "halve"
    # paper book
    paper_enabled: bool = True
    starting_cash: float = 100.0
    ledger_file: str = "data/paper-ledger.json"
    # pipeline
    history_limit: int = 10
    report_dir: str = "reports"
    stage_timeout_s: int = 120
    stop_on_needs_data: bool = True
    # dashboard
    refresh_seconds: int = 15
    reports_endpoint: str = "/api/reports"
    public_copy: bool = True
    # extras
    contracts_dir: str = "agents"
    raw: dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    def public_dict(self) -> dict[str, Any]:
        """Configuration safe to expose on the dashboard (nothing secret exists here anyway)."""
        data = asdict(self)
        data.pop("raw", None)
        return data


def _section(data: dict[str, Any], name: str) -> dict[str, Any]:
    value = data.get(name, {})
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(f"config section '{name}' must be a mapping")
    return value


def _pick(section: dict[str, Any], key: str, default: Any, caster):
    if key not in section:
        return default
    value = section[key]
    try:
        if caster is bool:
            if isinstance(value, bool):
                return value
            raise ValueError("must be a boolean")
        if caster is int:
            if isinstance(value, bool):
                raise ValueError("must be an integer")
            return int(value)
        return caster(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"config value '{key}' is invalid: {value!r} ({exc})") from exc


def load_config(path: str | os.PathLike[str] | None = None, overrides: dict[str, Any] | None = None) -> Config:
    """Load config.yaml, apply validated overrides, and enforce the paper-only rules."""
    config_path = Path(path or os.environ.get("OPUS_DESK_CONFIG") or DEFAULT_CONFIG_PATH)
    if not config_path.exists():
        raise ConfigError(f"config file not found: {config_path}")
    source_text = config_path.read_text(encoding="utf-8")
    try:
        if _yaml is not None:
            data = _yaml.safe_load(source_text) or {}
        else:
            data = load_yaml_subset(source_text)
    except YamlSubsetError as exc:
        raise ConfigError(f"config.yaml is outside the supported YAML subset: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - PyYAML raises its own error hierarchy
        raise ConfigError(f"config.yaml is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError("config.yaml must contain a mapping at the top level")

    scan = _section(data, "scan")
    news = _section(data, "news")
    charts = _section(data, "charts")
    strategy = _section(data, "strategy")
    risk = _section(data, "risk")
    paper = _section(data, "paper")
    pipeline = _section(data, "pipeline")
    dash = _section(data, "dashboard")
    data_sec = _section(data, "data")

    cfg = Config(
        mode=str(data.get("mode", "paper")).strip().lower(),
        allow_live_orders=bool(data.get("allow_live_orders", False)),
        source=str(data_sec.get("source", "fixture")).strip().lower(),
        fixture_file=str(data_sec.get("fixture_file", "data/fixtures.json")),
        gamma_base=str(data_sec.get("gamma_base", "https://gamma-api.polymarket.com")).rstrip("/"),
        clob_base=str(data_sec.get("clob_base", "https://clob.polymarket.com")).rstrip("/"),
        news_base=str(data_sec.get("news_base", "https://news.google.com/rss/search")),
        universe_limit=_pick(data_sec, "universe_limit", 500, int),
        page_size=_pick(data_sec, "page_size", 100, int),
        request_timeout_s=_pick(data_sec, "request_timeout_s", 15, int),
        retries=_pick(data_sec, "retries", 1, int),
        test_seed=_pick(data_sec, "test_seed", 20261019, int),
        shortlist_size=_pick(scan, "shortlist_size", 10, int),
        min_universe_size=_pick(scan, "min_universe_size", 20, int),
        min_liquidity=_pick(scan, "min_liquidity", 2000, float),
        max_spread=_pick(scan, "max_spread", 0.05, float),
        min_minutes_to_resolution=_pick(scan, "min_minutes_to_resolution", 10, int),
        activity_floor=_pick(scan, "activity_floor", 8, int),
        require_news=_pick(news, "require_news", True, bool),
        max_items=_pick(news, "max_items", 8, int),
        max_headline_age_hours=_pick(news, "max_headline_age_hours", 24, float),
        news_freshness_minutes=_pick(news, "news_freshness_minutes", 180, int),
        interval=str(charts.get("interval", "1d")),
        fidelity_minutes=_pick(charts, "fidelity_minutes", 15, int),
        min_history_points=_pick(charts, "min_history_points", 12, int),
        chart_freshness_minutes=_pick(charts, "chart_freshness_minutes", 60, int),
        min_net_rr=_pick(strategy, "min_net_rr", 1.5, float),
        max_stop_distance=_pick(strategy, "max_stop_distance", 0.12, float),
        max_entry_distance=_pick(strategy, "max_entry_distance", 0.12, float),
        max_pullback_distance=_pick(strategy, "max_pullback_distance", 0.05, float),
        time_limit_hours=_pick(strategy, "time_limit_hours", 6, int),
        bankroll=_pick(risk, "bankroll", 100, float),
        max_positions=_pick(risk, "max_positions", 5, int),
        max_total_exposure_pct=_pick(risk, "max_total_exposure_pct", 25, float),
        max_position_risk_pct=_pick(risk, "max_position_risk_pct", 2, float),
        max_daily_risk_pct=_pick(risk, "max_daily_risk_pct", 6, float),
        max_per_category=_pick(risk, "max_per_category", 2, int),
        max_per_event=_pick(risk, "max_per_event", 1, int),
        cost_buffer_pct=_pick(risk, "cost_buffer_pct", 2, float),
        min_reward_to_spread=_pick(risk, "min_reward_to_spread", 3, float),
        watchlist_freshness_minutes=_pick(risk, "watchlist_freshness_minutes", 30, int),
        event_risk_high=str(risk.get("event_risk_high", "block")),
        event_risk_medium=str(risk.get("event_risk_medium", "halve")),
        paper_enabled=_pick(paper, "enabled", True, bool),
        starting_cash=_pick(paper, "starting_cash", 100.0, float),
        ledger_file=str(paper.get("ledger_file", "data/paper-ledger.json")),
        history_limit=_pick(pipeline, "history_limit", 10, int),
        report_dir=str(pipeline.get("report_dir", "reports")),
        stage_timeout_s=_pick(pipeline, "stage_timeout_s", 120, int),
        stop_on_needs_data=_pick(pipeline, "stop_on_needs_data", True, bool),
        refresh_seconds=_pick(dash, "refresh_seconds", 15, int),
        reports_endpoint=str(dash.get("reports_endpoint", "/api/reports")),
        public_copy=_pick(dash, "public_copy", True, bool),
        raw=data,
    )

    if overrides:
        allowed = {f.name for f in Config.__dataclass_fields__.values()} - {"raw"}
        unknown = set(overrides) - allowed
        if unknown:
            raise ConfigError(f"unknown config override(s): {', '.join(sorted(unknown))}")
        cfg = Config(**{**asdict(cfg), "raw": data, **overrides})

    enforce_safety(cfg)
    return cfg


def enforce_safety(cfg: Config) -> None:
    """Refuse to run unless the desk is strictly paper-only."""
    if cfg.mode != "paper":
        raise ConfigError(f"refusing to run: mode must be 'paper' (got {cfg.mode!r})")
    if cfg.allow_live_orders is not False:
        raise ConfigError("refusing to run: allow_live_orders must be false")
    if cfg.source not in VALID_SOURCES:
        raise ConfigError(f"refusing to run: data.source must be one of {', '.join(VALID_SOURCES)}")
    if cfg.shortlist_size < 1:
        raise ConfigError("scan.shortlist_size must be at least 1")
    if cfg.universe_limit < cfg.min_universe_size:
        raise ConfigError("data.universe_limit must be at least scan.min_universe_size")
    if cfg.min_net_rr <= 0:
        raise ConfigError("strategy.min_net_rr must be positive")
    if cfg.bankroll <= 0:
        raise ConfigError("risk.bankroll must be positive")
    if cfg.starting_cash <= 0:
        raise ConfigError("paper.starting_cash must be positive")
    if not (0 < cfg.max_position_risk_pct <= 100):
        raise ConfigError("risk.max_position_risk_pct must be between 0 and 100")


def summary_lines(cfg: Config) -> list[str]:
    return [
        f"mode: {cfg.mode} (live orders: {cfg.allow_live_orders})",
        f"source: {cfg.source}",
        f"scan cap: {cfg.universe_limit} markets, watchlist {cfg.shortlist_size}",
        f"paper bankroll: ${cfg.starting_cash:,.0f} (simulated)",
        f"max {cfg.max_positions} positions, {cfg.max_total_exposure_pct:g}% exposure, "
        f"{cfg.max_position_risk_pct:g}% risk per trade",
        f"min liquidity ${cfg.min_liquidity:,.0f}, max spread {cfg.max_spread:g}",
        f"min net R:R {cfg.min_net_rr:g}, stop cap {cfg.max_stop_distance:g}",
    ]
