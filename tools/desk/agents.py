"""The six agents.

SCOUT    finds unusual markets; never recommends a trade.
NEWS     attaches dated sources; separates claims from speculation.
CHARTS   describes trend, momentum, levels and conflicts.
STRATEGY writes one rule-based plan, or WAIT.
RISK     may veto any plan; its checks are code, not prompt text.
BOSS     checks the whole desk and returns one of three statuses.

Every function is deterministic. Nothing here invents a price, headline or indicator value.
"""

from __future__ import annotations

import math
import re
from typing import Any, Callable, Iterable

from .config import Config
from .data import build_news_query, clamp, iso, median, num, robust_z

BOSS_DECISIONS = ("APPROVE_FOR_PAPER_TEST", "WAIT", "REJECT")
REPORT_STATUSES = ("complete", "needs_data", "rejected")

AGENT_LABELS = {
    "scout": "SCOUT",
    "news": "NEWS",
    "charts": "CHARTS",
    "strategy": "STRATEGY",
    "risk": "RISK",
    "boss": "BOSS",
}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def pct(value: float, digits: int = 2) -> str:
    return f"{value * 100:.{digits}f}%"


def money(value: float) -> str:
    return f"${value:,.2f}"


def rnd(value: float, digits: int = 4) -> float:
    return round(float(value) + 0.0, digits)


def base_report(agent: str, now_ms: int, status: str, summary: str, evidence: list,
                risks: list[str], next_step: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    if status not in REPORT_STATUSES:
        raise ValueError(f"invalid report status: {status}")
    return {
        "agent": agent,
        "label": AGENT_LABELS[agent],
        "timestamp_utc": iso(now_ms),
        "status": status,
        "summary": summary,
        "evidence": evidence,
        "risks": risks,
        "next_step": next_step,
        "meta": meta or {},
    }


# --------------------------------------------------------------------------- #
# technical analysis
# --------------------------------------------------------------------------- #

def _linreg_slope(values: list[float]) -> float:
    count = len(values)
    if count < 2:
        return 0.0
    mean_x = (count - 1) / 2
    mean_y = sum(values) / count
    numerator = sum((index - mean_x) * (value - mean_y) for index, value in enumerate(values))
    denominator = sum((index - mean_x) ** 2 for index in range(count))
    return 0.0 if denominator == 0 else numerator / denominator


def _cluster_levels(points: list[dict[str, float]], lookback: int = 2) -> list[dict[str, Any]]:
    clusters: dict[int, dict[str, Any]] = {}
    for index in range(lookback, len(points) - lookback):
        value = points[index]["p"]
        neighbours = [points[j]["p"] for j in range(index - lookback, index + lookback + 1) if j != index]
        is_high = all(value >= other for other in neighbours)
        is_low = all(value <= other for other in neighbours)
        if not is_high and not is_low:
            continue
        key = int(round(value / 0.005))
        if key in clusters:
            cluster = clusters[key]
            cluster["touches"] += 1
            cluster["sum"] += value
            cluster["level"] = cluster["sum"] / cluster["touches"]
            kind = "resistance" if is_high else "support"
            if cluster["kind"] != kind:
                cluster["kind"] = "either"
        else:
            clusters[key] = {"level": value, "sum": value, "touches": 1,
                             "kind": "resistance" if is_high else "support"}
    return sorted(({"level": rnd(cluster["level"]), "touches": cluster["touches"],
                    "kind": cluster["kind"]} for cluster in clusters.values()),
                  key=lambda item: item["level"])


def analyse_series(points: Iterable[dict[str, float]], min_points: int = 8) -> dict[str, Any] | None:
    """Describe one probability series without predicting it."""
    clean = [point for point in (points or [])
             if math.isfinite(num(point.get("p"), float("nan")))
             and math.isfinite(num(point.get("t"), float("nan")))]
    if len(clean) < min_points:
        return None

    values = [float(point["p"]) for point in clean]
    last = values[-1]
    span_hours = max((clean[-1]["t"] - clean[0]["t"]) / 3_600_000, 1e-6)
    per_point_hours = span_hours / (len(clean) - 1)
    slope = _linreg_slope(values) / per_point_hours
    last4 = values[-4:]
    momentum_1h = last - last4[0] if len(last4) >= 2 else 0.0
    last12 = values[-12:]
    slope_3h = (_linreg_slope(last12) / per_point_hours) if len(last12) >= 3 else slope

    diffs = [abs(values[i] - values[i - 1]) for i in range(1, len(values))]
    atr = sum(diffs) / len(diffs) if diffs else 0.0
    atr_pct = atr / last if last > 0 else 0.0

    window_min = min(values)
    window_max = max(values)
    range_pos = (last - window_min) / (window_max - window_min) if window_max > window_min else 0.5
    change_pct = (last - values[0]) / values[0] if values[0] > 0 else 0.0

    clusters = _cluster_levels(clean)
    strong = [cluster for cluster in clusters if cluster["touches"] >= 2]
    supports = sorted((c for c in strong if c["level"] <= last * 1.002),
                      key=lambda c: c["level"], reverse=True)
    resistances = sorted((c for c in strong if c["level"] >= last * 0.998),
                         key=lambda c: c["level"])

    prior = values[: max(1, len(values) - 4)]
    prior_max, prior_min = max(prior), min(prior)
    structure_break = None
    if last > prior_max + atr * 0.5:
        structure_break = "up"
    elif last < prior_min - atr * 0.5:
        structure_break = "down"

    if slope > atr * 1.2 and slope > 0:
        trend = "up"
    elif slope < -atr * 1.2 and slope < 0:
        trend = "down"
    else:
        trend = "range"

    conflicts: list[str] = []
    warnings: list[str] = []
    if trend == "up" and momentum_1h < -atr:
        conflicts.append("daily trend up but last hour falling")
    if trend == "down" and momentum_1h > atr:
        conflicts.append("daily trend down but last hour rising")
    if trend == "range" and structure_break:
        conflicts.append(f"range-bound series with a {structure_break} structure break")
    if trend == "up" and range_pos > 0.97:
        warnings.append("uptrend is extended at the top of its range")
    if trend == "down" and range_pos < 0.03:
        warnings.append("downtrend is extended at the bottom of its range")
    if atr_pct > 0.12:
        warnings.append(f"average bar range is {pct(atr_pct, 1)} of price, which is unusually noisy")
    if len(values) < 40:
        warnings.append(f"only {len(values)} bars in the window")

    recent = values[-8:]
    recent_mean = sum(recent) / len(recent)
    stretch = (last - recent_mean) / atr if atr > 0 else 0.0
    extended_up = range_pos > 0.96 and stretch > 1.5
    activity = (sum(1 for i in range(1, len(values)) if values[i] != values[i - 1])
                / (len(values) - 1)) if len(values) > 1 else 0.0

    return {
        "points": len(values),
        "span_hours": rnd(span_hours, 1),
        "last": rnd(last),
        "change_pct": rnd(change_pct),
        "slope_per_hour": rnd(slope, 5),
        "slope_3h": rnd(slope_3h, 5),
        "momentum_1h": rnd(momentum_1h),
        "atr": rnd(atr),
        "atr_pct": rnd(atr_pct),
        "window_min": rnd(window_min),
        "window_max": rnd(window_max),
        "prior_high": rnd(prior_max),
        "prior_low": rnd(prior_min),
        "range_position": rnd(range_pos, 3),
        "structure_break": structure_break,
        "trend": trend,
        "activity": rnd(activity, 3),
        "recent_low": rnd(min(recent)),
        "recent_high": rnd(max(recent)),
        "stretch": rnd(stretch, 2),
        "extended_up": extended_up,
        "levels": {
            "support": [level["level"] for level in supports[:2]],
            "resistance": [level["level"] for level in resistances[:2]],
            "strong_support": supports[0] if supports else None,
            "strong_resistance": resistances[0] if resistances else None,
            "all_strong": strong[:6],
        },
        "conflicts": conflicts,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# AGENT 1 — SCOUT
# --------------------------------------------------------------------------- #

def _category_stats(markets: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for market in markets:
        grouped.setdefault(market["category"], []).append(market)
    stats = {}
    for category, items in grouped.items():
        stats[category] = {
            "count": len(items),
            "median_volume": median([m["volume_24h"] for m in items if m["volume_24h"] > 0]),
            "log_volumes": [math.log1p(max(m["volume_24h"], 0)) for m in items],
            "abs_moves_1h": [abs(m["move_1h"]) for m in items],
            "abs_moves_24h": [abs(m["move_24h"]) for m in items],
        }
    return stats


def _quality_reasons(market: dict[str, Any], cfg: Config, now_ms: int) -> tuple[bool, list[str], float]:
    reasons: list[str] = []
    has_quote = market.get("has_quote") is True and market.get("spread") is not None
    spread_pct = (market["spread"] / market["price"]) if has_quote and market["price"] > 0 else 1.0
    if not market["accepting_orders"]:
        reasons.append("not accepting orders")
    if market["closed"]:
        reasons.append("market is closed")
    if not market["enable_order_book"]:
        reasons.append("no order book enabled")
    if not market["tokens"][0] or not market["tokens"][1]:
        reasons.append("missing CLOB token ids")
    if not has_quote:
        reasons.append("no two-sided quote in the feed")
    if market["liquidity"] < cfg.min_liquidity:
        reasons.append(f"liquidity {money(market['liquidity'])} below floor {money(cfg.min_liquidity)}")
    if has_quote and market["spread"] > cfg.max_spread:
        reasons.append(f"spread {market['spread']:.3f} wider than {cfg.max_spread:g}")
    if has_quote and spread_pct > 0.2:
        reasons.append(f"spread is {pct(spread_pct, 0)} of the quoted price")
    if not math.isfinite(market["end_ms"]):
        reasons.append("no resolution date")
    elif market["end_ms"] - now_ms < cfg.min_minutes_to_resolution * 60_000:
        reasons.append("resolves too soon to manage a position")
    return (not reasons), reasons, spread_pct


def run_scout(universe: list[dict[str, Any]], universe_meta: dict[str, Any],
              cfg: Config, now_ms: int) -> dict[str, Any]:
    stats = _category_stats(universe)
    scored: list[dict[str, Any]] = []
    excluded = {"quality": 0, "data": 0, "low_signal": 0, "invalid": 0}
    data_gaps = {"missing_price": 0, "missing_volume": 0}

    for market in universe:
        price = market.get("price")
        if not math.isfinite(num(price, float("nan"))) or not (0 < price < 1):
            excluded["invalid"] += 1
            data_gaps["missing_price"] += 1
            continue
        ok, reasons, spread_pct = _quality_reasons(market, cfg, now_ms)
        if not ok:
            excluded["quality"] += 1
            continue
        if market["volume_24h"] <= 0:
            data_gaps["missing_volume"] += 1

        cat = stats.get(market["category"]) or stats.get("other") or {}
        z_move_1h = robust_z(abs(market["move_1h"]), cat.get("abs_moves_1h", []))
        z_move_24h = robust_z(abs(market["move_24h"]), cat.get("abs_moves_24h", []))
        z_volume = robust_z(math.log1p(max(market["volume_24h"], 0)), cat.get("log_volumes", []))
        ratio = (market["volume_24h"] / cat["median_volume"]
                 if cat.get("median_volume") else 1.0)

        reasons_out: list[str] = []
        score = 0.0
        if z_move_1h > 2:
            score += min(24, 9 * z_move_1h)
            reasons_out.append(f"1h move {pct(abs(market['move_1h']), 1)} is {z_move_1h:.1f}σ vs its category")
        elif abs(market["move_1h"]) >= 0.05:
            score += 6
            reasons_out.append(f"1h move {pct(abs(market['move_1h']), 1)} above the 5% activity band")
        if z_move_24h > 2:
            score += min(20, 7 * z_move_24h)
            reasons_out.append(f"24h move {pct(abs(market['move_24h']), 1)} is {z_move_24h:.1f}σ vs its category")
        if z_volume > 2:
            score += min(22, 8 * z_volume)
            reasons_out.append(f"24h volume {money(market['volume_24h'])} is {ratio:.1f}× the category median")
        elif ratio > 3:
            score += 10
            reasons_out.append(f"24h volume {ratio:.1f}× the category median")
        if market["move_1h"] * market["move_24h"] > 0 and abs(market["move_24h"]) > 0.02:
            score += 6
            reasons_out.append("1h and 24h moves point the same way")
        if spread_pct < 0.01:
            score += 4
            reasons_out.append("tight spread relative to price")
        if market["comment_count"] >= 100:
            score += 3
            reasons_out.append(f"{int(market['comment_count'])} comments on the event")

        score = int(clamp(score, 0, 100))
        if score < cfg.activity_floor:
            excluded["low_signal"] += 1
            continue

        scored.append({
            "market": market,
            "score": score,
            "reasons": reasons_out,
            "metrics": {
                "move_1h": market["move_1h"],
                "move_24h": market["move_24h"],
                "z_move_1h": rnd(z_move_1h, 2),
                "z_move_24h": rnd(z_move_24h, 2),
                "z_volume": rnd(z_volume, 2),
                "volume_ratio": rnd(ratio, 2),
                "spread": market["spread"],
                "spread_pct": rnd(spread_pct, 4),
                "liquidity": market["liquidity"],
                "volume_24h": market["volume_24h"],
                "price": rnd(market["price"]),
            },
        })

    scored.sort(key=lambda item: item["score"], reverse=True)
    shortlist = scored[: cfg.shortlist_size]

    categories = {category: stat["count"] for category, stat in stats.items()}
    status = "needs_data" if len(universe) < cfg.min_universe_size else "complete"
    summary = (f"Scanned {len(universe)} markets, {len(scored)} passed quality filters, "
               f"{len(shortlist)} on the watchlist." if universe
               else "No markets were supplied, so there is nothing to scan.")

    evidence = [{
        "market_id": item["market"]["id"],
        "question": item["market"]["question"],
        "url": item["market"]["url"],
        "category": item["market"]["category"],
        "event_id": item["market"]["event_id"],
        "event_title": item["market"]["event_title"],
        "order_min_size": item["market"]["order_min_size"],
        "score": item["score"],
        "reasons": item["reasons"],
        "metrics": item["metrics"],
        "price": rnd(item["market"]["price"]),
        "ends_at": item["market"]["end_date"],
        "source_timestamp": item["market"]["updated_at"],
        "synthetic": bool(item["market"]["synthetic"]),
        "regime": item["market"].get("regime"),
    } for item in shortlist]

    risks = []
    if status == "needs_data":
        risks.append(f"Universe has {len(universe)} markets; at least {cfg.min_universe_size} are required.")
    if not shortlist:
        risks.append(f"No market produced a score above the {cfg.activity_floor}-point activity floor.")
    if data_gaps["missing_volume"]:
        risks.append(f"{data_gaps['missing_volume']} markets reported no 24h volume.")
    if universe_meta.get("synthetic"):
        risks.append("Universe is SYNTHETIC TEST DATA. Scores describe generated numbers, not a real market.")

    return base_report(
        "scout", now_ms, status, summary, evidence, risks,
        "News agent: attach dated sources to each watchlist item.",
        {
            "universe_size": len(universe),
            "universe_source": universe_meta.get("source", "unknown"),
            "universe_label": universe_meta.get("label", ""),
            "fetched_at": universe_meta.get("fetched_at"),
            "source_note": universe_meta.get("note", ""),
            "scored_count": len(scored),
            "shortlist": [{"market_id": item["market"]["id"],
                           "category": item["market"]["category"],
                           "score": item["score"]} for item in shortlist],
            "excluded": excluded,
            "data_gaps": data_gaps,
            "categories": categories,
            "methodology": ("Robust z-scores (median/MAD) of |1h move|, |24h move| and log 24h volume "
                            "against the same category. No forecast is produced; the list is an attention "
                            "filter only."),
        },
    )


# --------------------------------------------------------------------------- #
# AGENT 2 — NEWS
# --------------------------------------------------------------------------- #

POSITIVE_WORDS = re.compile(
    r"\b(beat|beats|surge|surges|rally|rallies|approve|approved|approves|pass|passes|passed|win|wins|"
    r"won|above|record|upgrade|upgraded|strong|boost|boosts|deal|agreement|confirmed|cleared|advance|advances)\b",
    re.I)
NEGATIVE_WORDS = re.compile(
    r"\b(miss|misses|drop|drops|fall|falls|fell|reject|rejected|fails|failed|below|downgrade|"
    r"downgraded|weak|halts|halted|delay|delayed|probe|lawsuit|cut|cuts|slump|slumps|crash|crashes)\b",
    re.I)
SPECULATION_WORDS = re.compile(
    r"\b(may|might|could|reportedly|rumou?r|speculat\w*|expected|analysts?|forecast|likely|unconfirmed|"
    r"sources say)\b", re.I)
EVENT_RISK_WORDS = re.compile(
    r"\b(fomc|cpi|nfp|payrolls|election|vote|verdict|hearing|rate decision|earnings|kickoff|halftime|"
    r"final whistle|scheduled|deadline|auction)\b", re.I)


def _tone_of(text: str) -> tuple[str, int, int]:
    positives = len(POSITIVE_WORDS.findall(text))
    negatives = len(NEGATIVE_WORDS.findall(text))
    if positives > negatives:
        return "constructive", positives, negatives
    if negatives > positives:
        return "cautious", positives, negatives
    return "neutral", positives, negatives


def run_news(scout_report: dict[str, Any],
             market_lookup: Callable[[str], dict[str, Any] | None],
             news_fetcher: Callable[[dict[str, Any]], list[dict[str, Any]]],
             cfg: Config, now_ms: int,
             on_market: Callable[[str, int], None] | None = None) -> dict[str, Any]:
    evidence: list[dict[str, Any]] = []
    risks: list[str] = []
    fetched = failed = markets_with_sources = 0

    for item in scout_report["evidence"]:
        market = market_lookup(item["market_id"])
        fetched += 1
        if market is None:
            failed += 1
            risks.append(f"Market {item['market_id']} disappeared from the scanned universe before the news pass.")
            continue
        error = None
        try:
            headlines = news_fetcher(market)
        except Exception as exc:  # noqa: BLE001 - a failed feed must be reported, not hidden
            headlines = []
            error = str(exc)
            failed += 1

        query = build_news_query(market)
        query_tokens = {token for token in query.lower().split() if token}
        seen: set[str] = set()
        items: list[dict[str, Any]] = []

        for headline in headlines:
            title = str(headline.get("title") or "").strip()
            if not title:
                continue
            normalised = " ".join(title.lower().split())
            duplicate = normalised in seen
            seen.add(normalised)
            published_ms = num(headline.get("published_ms"), float("nan"))
            age_hours = ((now_ms - published_ms) / 3_600_000
                         if math.isfinite(published_ms) else None)
            words = set(re.findall(r"[a-z0-9]+", title.lower()))
            overlap = len(query_tokens & words)
            tone, positives, negatives = _tone_of(title)
            items.append({
                "title": title,
                "link": headline.get("link") or "",
                "source": headline.get("source") or "unattributed",
                "source_url": headline.get("sourceUrl") or "",
                "published_at": headline.get("published_at"),
                "age_hours": None if age_hours is None else rnd(age_hours, 1),
                "stale": True if age_hours is None else age_hours > cfg.max_headline_age_hours,
                "speculative": bool(SPECULATION_WORDS.search(title)),
                "duplicate": duplicate,
                "query_overlap": overlap,
                "relevance": ("pooled" if market["synthetic"] else
                              "direct" if overlap >= 2 else
                              "partial" if overlap == 1 else "unclear"),
                "tone": tone,
                "tone_counts": [positives, negatives],
                **({"synthetic": True} if headline.get("synthetic") else {}),
            })

        usable = [entry for entry in items if not entry["duplicate"]]
        fresh = [entry for entry in usable if not entry["stale"]]
        direct = [entry for entry in usable if entry["relevance"] == "direct"]
        sources = sorted({entry["source"] for entry in usable})
        tone_counts = {"constructive": 0, "cautious": 0, "neutral": 0}
        for entry in usable:
            tone_counts[entry["tone"]] += 1
        keyword_tone = ("constructive" if tone_counts["constructive"] > tone_counts["cautious"] else
                        "cautious" if tone_counts["cautious"] > tone_counts["constructive"] else "neutral")
        yes_no = market["outcomes"][0].strip().lower() in ("yes", "no")
        # Pooled test headlines and team-vs-team outcomes have no meaningful keyword polarity.
        tone = "not_applicable" if (market["synthetic"] or not yes_no) else keyword_tone

        if market["synthetic"] and market.get("event_risk_hint"):
            event_risk = market["event_risk_hint"]
        elif market["category"] in ("econ", "politics"):
            event_risk = "medium"
        elif any(EVENT_RISK_WORDS.search(entry["title"]) for entry in usable):
            event_risk = "medium"
        else:
            event_risk = "low" if market["synthetic"] else "unknown"

        flags = []
        if not usable:
            flags.append("NO_SOURCES")
        if usable and not fresh:
            flags.append("STALE_ONLY")
        if any(entry["duplicate"] for entry in items):
            flags.append("DUPLICATES_REMOVED")
        if market["synthetic"]:
            flags.append("SYNTHETIC_HEADLINES")
        if not market["synthetic"] and usable and not direct:
            flags.append("LOW_RELEVANCE")
        if not math.isfinite(market["end_ms"]):
            flags.append("NO_RESOLUTION_DATE")

        if usable:
            markets_with_sources += 1
        record = {
            "market_id": market["id"],
            "question": market["question"],
            "query": query,
            "source_count": len(sources),
            "sources": sources,
            "headline_count": len(usable),
            "fresh_count": len(fresh),
            "direct_count": len(direct),
            "tone": tone,
            "keyword_tone": keyword_tone,
            "tone_counts": tone_counts,
            "direction_basis": ("not used for rules: synthetic pooled headlines have no real polarity"
                                if market["synthetic"] else
                                "keyword polarity applied to the first outcome label; may not fit inverted questions"),
            "event_risk": event_risk,
            "flags": flags,
            "items": items,
        }
        if not (usable and fresh):
            record.update({"source_count": 0, "sources": [], "headline_count": 0,
                           "fresh_count": 0, "direct_count": 0, "tone": "unknown"})
            if error:
                record["error"] = error
            risks.append(f"No usable dated sources for \"{market['question']}\".")
        evidence.append(record)
        if on_market:
            on_market(market["id"], len(usable))

    covered = [entry["market_id"] for entry in evidence if entry["fresh_count"] > 0]
    if not scout_report["evidence"] or not markets_with_sources or (fetched and failed == fetched):
        status = "needs_data"
    else:
        status = "complete"

    summary = (f"Checked sources for {fetched} watchlist markets; "
               f"{markets_with_sources} have at least one usable headline."
               if scout_report["evidence"] else "No watchlist supplied, so no news could be checked.")
    if not covered:
        risks.append("No watchlist market has a fresh, dated source.")
    if cfg.require_news:
        risks.append("Desk rule: a trade plan requires at least one fresh source. "
                     "Markets with NO_SOURCES are dropped by Strategy.")

    return base_report(
        "news", now_ms, status, summary, evidence, risks,
        "Charts agent: review the price series for the markets that carry sources.",
        {
            "fetched": fetched,
            "failed": failed,
            "markets_with_sources": markets_with_sources,
            "covered_market_ids": covered,
            "headline_policy": ("Headlines are claims, not verified facts. Items are flagged speculative "
                                "when they use words like may, reportedly or analysts expect. No article is "
                                "summarised beyond its title, so no detail is invented."),
            "require_news": cfg.require_news,
        },
    )


# --------------------------------------------------------------------------- #
# AGENT 3 — CHARTS
# --------------------------------------------------------------------------- #

def run_charts(scout_report: dict[str, Any], news_report: dict[str, Any],
               histories: dict[str, dict[str, Any]], cfg: Config, now_ms: int) -> dict[str, Any]:
    evidence: list[dict[str, Any]] = []
    risks: list[str] = []
    news_by_id = {entry["market_id"]: entry for entry in news_report["evidence"]}

    for item in scout_report["evidence"]:
        news = news_by_id.get(item["market_id"])
        series = histories.get(item["market_id"])
        if not series or not series.get("points"):
            evidence.append({
                "market_id": item["market_id"],
                "question": item["question"],
                "status": "needs_data",
                "reason": "no price history returned for the primary token",
                "timeframe": "15m bars, 24h window",
            })
            risks.append(f"No price history for \"{item['question']}\".")
            continue

        primary = analyse_series(series["points"], min_points=cfg.min_history_points)
        if primary is None:
            evidence.append({
                "market_id": item["market_id"],
                "question": item["question"],
                "status": "needs_data",
                "reason": (f"only {len(series['points'])} usable points; "
                           f"minimum is {cfg.min_history_points}"),
                "timeframe": "15m bars, 24h window",
                "data_quality": {"points": len(series["points"]), "span_hours": None},
            })
            risks.append(f"History for \"{item['question']}\" is too short to analyse.")
            continue

        inverse_points = [{"t": point["t"], "p": rnd(clamp(1 - point["p"], 0.001, 0.999))}
                          for point in series["points"]]
        secondary = analyse_series(inverse_points, min_points=cfg.min_history_points)

        conflicts = list(primary["conflicts"])
        warnings = list(primary["warnings"])
        direct_news = (news or {}).get("direct_count", 0) >= 2
        if direct_news and news["tone"] == "cautious" and primary["trend"] == "up":
            conflicts.append("chart trend is up while two or more direct headlines read cautious")
        if direct_news and news["tone"] == "constructive" and primary["trend"] == "down":
            conflicts.append("chart trend is down while two or more direct headlines read constructive")
        if news and news.get("event_risk") == "high":
            conflicts.append("high event risk on the calendar")

        evidence.append({
            "market_id": item["market_id"],
            "question": item["question"],
            "status": "complete",
            "timeframe": f"{cfg.fidelity_minutes}m bars, 24h window",
            "series_source": series.get("source", "price history API"),
            "last_quote": item["price"],
            "primary_outcome": (series.get("outcomes") or ["Outcome A"])[0],
            "secondary_outcome": (series.get("outcomes") or ["Outcome A", "Outcome B"])[1],
            "views": {"primary": primary, "secondary": secondary},
            "sparkline": [rnd(point["p"]) for index, point in enumerate(series["points"]) if index % 3 == 0],
            "conflicts": conflicts,
            "warnings": warnings,
            "data_quality": {
                "points": primary["points"],
                "span_hours": primary["span_hours"],
                "fetched_at": series.get("fetched_at"),
            },
            "news_flags": (news or {}).get("flags", []),
        })

    usable = [entry for entry in evidence if entry["status"] == "complete"]
    status = "complete" if usable else "needs_data"
    summary = (f"Reviewed {len(usable)} price series. "
               f"{sum(1 for entry in usable if entry['views']['primary']['trend'] != 'range')} show a "
               f"directional trend; {sum(1 for entry in usable if entry['conflicts'])} carry conflicting signals."
               if usable else "No usable price series, so no chart review is possible.")

    return base_report(
        "charts", now_ms, status, summary, evidence, risks,
        "Strategy agent: build one rule-based plan per market, or return WAIT.",
        {
            "reviewed": len(usable),
            "needs_data": len(evidence) - len(usable),
            "methodology": (
                "24h of 15-minute closes. Trend from a linear fit in probability points per hour vs "
                "average bar range. Support/resistance are clustered swing pivots with at least two "
                "touches. The secondary view is the exact inverse of the primary series, so both "
                "outcomes are analysed the same way."),
            "conflicts_total": sum(len(entry["conflicts"]) for entry in usable),
            "warnings_total": sum(len(entry["warnings"]) for entry in usable),
        },
    )


# --------------------------------------------------------------------------- #
# AGENT 4 — STRATEGY
# --------------------------------------------------------------------------- #

def _choose_view(chart: dict[str, Any]) -> str | None:
    primary, secondary = chart["views"]["primary"], chart["views"]["secondary"]
    if primary["trend"] == "up" and secondary["trend"] == "down":
        return "primary"
    if primary["trend"] == "down" and secondary["trend"] == "up":
        return "secondary"
    if primary["structure_break"] == "up":
        return "primary"
    if secondary["structure_break"] == "up":
        return "secondary"
    return None


def _nearest_support_below(levels: list[float], price: float) -> float | None:
    below = sorted((level for level in levels if level < price), reverse=True)
    return below[0] if below else None


def _nearest_resistance_above(levels: list[float], price: float) -> float | None:
    above = sorted(level for level in levels if level > price)
    return above[0] if above else None


def run_strategy(scout_report: dict[str, Any], news_report: dict[str, Any],
                 charts_report: dict[str, Any], cfg: Config, now_ms: int) -> dict[str, Any]:
    news_by_id = {entry["market_id"]: entry for entry in news_report["evidence"]}
    scout_by_id = {entry["market_id"]: entry for entry in scout_report["evidence"]}
    plans: list[dict[str, Any]] = []

    for chart in charts_report["evidence"]:
        if chart["status"] != "complete":
            continue
        scout = scout_by_id.get(chart["market_id"])
        news = news_by_id.get(chart["market_id"])
        reasons: list[str] = []
        disagreements: list[str] = []

        if cfg.require_news and not (news or {}).get("fresh_count"):
            reasons.append("no fresh dated source; desk rule requires news before a plan")
        if (news or {}).get("event_risk") == "high":
            reasons.append("high event risk")
        if "LOW_RELEVANCE" in (news or {}).get("flags", []):
            reasons.append("headline set does not clearly match the question")

        side_key = _choose_view(chart)
        view = chart["views"][side_key] if side_key else None
        side_label = (chart["primary_outcome"] if side_key == "primary"
                      else chart["secondary_outcome"]) if side_key else None

        if not side_key or not view:
            plans.append({
                "market_id": chart["market_id"],
                "question": chart["question"],
                "status": "WAIT",
                "reason": ("; ".join(reasons) if reasons
                           else "no directional trend or confirmed structure break"),
                "trend": chart["views"]["primary"]["trend"],
                "disagreements": disagreements,
            })
            continue

        if (news or {}).get("tone") == "cautious" and view["trend"] == "up":
            disagreements.append("headline tone is cautious while the trade direction is up")
        disagreements.extend(chart["conflicts"])
        if view["atr_pct"] > 0.12:
            reasons.append(f"average bar range {pct(view['atr_pct'], 1)} is too noisy for a fixed stop")

        price = view["last"]
        atr = max(view["atr"], 0.002)
        scout_price = (scout or {}).get("price", price)
        scout_spread = ((scout or {}).get("metrics") or {}).get("spread") or 0
        quote = rnd(clamp(scout_price + scout_spread / 2 if side_key == "primary"
                          else 1 - (scout_price - scout_spread / 2), 0.01, 0.98), 3)

        support_level = _nearest_support_below([level["level"] for level in view["levels"]["all_strong"]], price)
        resistance_level = _nearest_resistance_above([level["level"] for level in view["levels"]["all_strong"]], price)
        structure = view["structure_break"]
        extended = view["extended_up"]

        if structure == "up":
            broken_level = view["prior_high"]
            if extended:
                entry_type = "breakout_retest"
                entry = rnd(clamp(broken_level + atr * 0.25, 0.01, 0.975), 3)
                entry_zone = [rnd(clamp(broken_level - atr * 0.25, 0.005, 0.97), 3),
                              rnd(clamp(broken_level + atr * 0.5, 0.01, 0.98), 3)]
                trigger = f"retest of {broken_level:.3f} holds after the structure break"
            else:
                entry_type = "breakout"
                entry = quote
                entry_zone = [rnd(clamp(broken_level, 0.005, 0.97), 3),
                              rnd(clamp(entry + atr * 0.5, 0.01, 0.98), 3)]
                trigger = f"quote holds above {broken_level:.3f} with the break intact"
        elif view["trend"] == "up":
            entry_type = "pullback"
            support = support_level if support_level is not None else max(price - atr * 1.5, view["window_min"])
            entry = rnd(clamp(support + atr * 0.25, 0.005, 0.97), 3)
            entry_zone = [rnd(clamp(support, 0.005, 0.97), 3),
                          rnd(clamp(support + atr, 0.01, 0.98), 3)]
            trigger = f"price pulls back into {support:.3f}-{(support + atr):.3f} and holds"
        else:
            entry_type = "reversal"
            reclaim = min(view["window_max"], quote + atr)
            entry = rnd(clamp(reclaim + atr * 0.25, 0.005, 0.975), 3)
            entry_zone = [rnd(clamp(reclaim, 0.005, 0.97), 3),
                          rnd(clamp(reclaim + atr, 0.01, 0.98), 3)]
            trigger = f"price reclaims {reclaim:.3f} and momentum stays positive"

        if extended and structure != "up":
            reasons.append("price is stretched above its recent mean; wait for a pullback")

        min_gap = max(atr * 0.5, 0.006)
        if entry_type == "breakout_retest":
            invalidation = rnd(clamp(view["prior_high"] - atr * 0.75, 0.005, entry - 0.005), 3)
        else:
            candidates = [value for value in (
                (support_level - atr * 0.25) if support_level is not None else None,
                (view["recent_low"] - atr * 0.25) if view.get("recent_low") is not None else None,
                entry - atr * 2,
            ) if value is not None and value <= entry - min_gap]
            invalidation = rnd(clamp(max(candidates) if candidates else entry - atr * 2,
                                     0.005, entry - 0.005), 3)

        floor_target = entry + max(atr * 4, 0.05)
        level_target = (resistance_level
                        if resistance_level is not None and resistance_level > entry + 0.008 else None)
        target = rnd(clamp(max(floor_target, level_target or 0), entry + 0.01, 0.985), 3)

        if entry_type == "pullback" and quote - entry > cfg.max_pullback_distance:
            reasons.append(f"pullback entry is {(quote - entry):.3f} below the quote, "
                           f"beyond the {cfg.max_pullback_distance:g} limit")
        if entry_type in ("pullback", "breakout_retest") and entry >= quote:
            reasons.append("conditional entry is not below the current quote")
        if target <= quote + 0.005:
            reasons.append(f"target {target:.3f} is not above the current quote {quote:.3f}; "
                           "the move may already be priced")
        if entry - invalidation > cfg.max_stop_distance:
            reasons.append(f"stop distance {(entry - invalidation):.3f} exceeds the "
                           f"{cfg.max_stop_distance:g} limit")
        if entry <= invalidation:
            reasons.append("entry is not above invalidation")
        if abs(entry - quote) > cfg.max_entry_distance:
            reasons.append(f"entry {entry:.3f} is more than {cfg.max_entry_distance:g} away from "
                           f"the quote {quote:.3f}")

        risk_per_share = rnd(entry - invalidation)
        reward_per_share = rnd(target - entry)
        rr = rnd(reward_per_share / risk_per_share, 2) if risk_per_share > 0 else 0.0
        if rr < cfg.min_net_rr:
            reasons.append(f"gross reward:risk {rr:.2f} below {cfg.min_net_rr:g}")

        market_end_ms = _parse_iso(scout.get("ends_at")) if scout else float("nan")
        time_limit_ms = min(now_ms + cfg.time_limit_hours * 3_600_000,
                            market_end_ms - cfg.min_minutes_to_resolution * 60_000
                            if math.isfinite(market_end_ms) else now_ms + cfg.time_limit_hours * 3_600_000)

        neutral_tone = (not news or news.get("tone") in (None, "neutral", "not_applicable", "unknown"))
        confidence_parts = [
            25 if view["trend"] != "range" else 0,
            20 if structure else 0,
            15 if view["atr_pct"] < 0.06 else 5,
            15 if ((scout or {}).get("metrics") or {}).get("z_volume", 0) > 1 else 5,
            15 if (news or {}).get("fresh_count") else 0,
            10 if neutral_tone or (news.get("tone") == "constructive") == (view["trend"] == "up") else 0,
        ]
        confidence = int(clamp(sum(confidence_parts), 0, 100))
        status = "WAIT" if reasons else "plan"

        plans.append({
            "market_id": chart["market_id"],
            "question": chart["question"],
            "url": (scout or {}).get("url", ""),
            "status": status,
            "reason": "; ".join(reasons) if reasons else None,
            "side_key": side_key,
            "side": side_label,
            "side_index": 0 if side_key == "primary" else 1,
            "entry_type": entry_type,
            "entry": entry if status == "plan" else None,
            "quote": quote,
            "entry_distance": rnd(abs(entry - quote), 3),
            "entry_zone": entry_zone,
            "entry_trigger": trigger,
            "invalidation": invalidation if status == "plan" else None,
            "target": target if status == "plan" else None,
            "risk_per_share": risk_per_share if status == "plan" else None,
            "reward_per_share": reward_per_share if status == "plan" else None,
            "gross_rr": rr,
            "time_limit_utc": iso(time_limit_ms),
            "confidence": confidence,
            "evidence_used": {
                "scout_score": (scout or {}).get("score"),
                "scout_reasons": (scout or {}).get("reasons", []),
                "chart_trend": view["trend"],
                "chart_levels": view["levels"],
                "chart_conflicts": chart["conflicts"],
                "chart_warnings": chart.get("warnings", []),
                "news_sources": (news or {}).get("sources", []),
                "news_direct_count": (news or {}).get("direct_count", 0),
                "news_tone": (news or {}).get("tone", "unknown"),
                "news_count": (news or {}).get("fresh_count", 0),
                "event_risk": (news or {}).get("event_risk", "unknown"),
            },
            "disagreements": disagreements,
        })

    candidates = [plan for plan in plans if plan["status"] == "plan"]
    status = "complete" if plans else "needs_data"
    summary = (f"Wrote {len(candidates)} rule-based plan(s) from {len(plans)} reviewed markets; "
               f"{len(plans) - len(candidates)} returned WAIT."
               if plans else "No chart-reviewed market reached the strategy stage.")

    return base_report(
        "strategy", now_ms, status, summary, plans,
        [] if candidates else ["Every candidate returned WAIT; no plan was forced."],
        "Risk agent: size or veto each plan.",
        {
            "reviewed": len(plans),
            "plans": len(candidates),
            "waits": len(plans) - len(candidates),
            "policy": ("A plan exists only when trend and structure agree, the stop is inside the max "
                       "distance, and reward:risk clears the configured floor. Entries at the quote "
                       "fill immediately in the paper book; pullbacks, retests and reversals rest as "
                       "working orders until the market trades to the level. Strategy never sizes a "
                       "position and never places an order."),
        },
    )


def _parse_iso(value: Any) -> float:
    if not value:
        return float("nan")
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return float("nan")


# --------------------------------------------------------------------------- #
# AGENT 5 — RISK
# --------------------------------------------------------------------------- #

def _cost_per_share(price: float, spread: float, cfg: Config) -> float:
    return spread / 2 + price * (cfg.cost_buffer_pct / 100)


def _question_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def run_risk(strategy_report: dict[str, Any], news_report: dict[str, Any],
             scout_report: dict[str, Any], charts_report: dict[str, Any],
             context: dict[str, Any] | None, cfg: Config, now_ms: int) -> dict[str, Any]:
    context = context or {}
    open_positions = context.get("open_positions", [])
    bankroll = num(context.get("bankroll"), cfg.bankroll)

    common: list[dict[str, Any]] = []
    report_times = [(report.get("agent"), _parse_iso(report.get("timestamp_utc")))
                    for report in (scout_report, news_report, charts_report, strategy_report)]
    missing = [name for name, stamp in report_times if not math.isfinite(stamp)]
    if missing:
        common.append({"name": "pipeline_complete", "pass": False,
                       "detail": f"missing timestamp on: {', '.join(missing)}"})
    else:
        oldest = max((now_ms - stamp) / 60_000 for _, stamp in report_times)
        common.append({"name": "input_freshness",
                       "pass": oldest <= cfg.watchlist_freshness_minutes,
                       "detail": (f"oldest upstream report is {oldest:.1f} min old "
                                  f"(limit {cfg.watchlist_freshness_minutes})")})
    common.append({"name": "paper_mode",
                   "pass": cfg.mode == "paper" and cfg.allow_live_orders is False,
                   "detail": f"mode={cfg.mode}, allow_live_orders={cfg.allow_live_orders}"})

    news_by_id = {entry["market_id"]: entry for entry in news_report["evidence"]}
    decisions: list[dict[str, Any]] = []
    cash = num(context.get("cash"), bankroll)
    working_orders = context.get("working_orders") or []
    # Resting orders reserve capacity: count their notional and risk as if they were positions.
    reserved = [
        {**order, "notional": round(num(order.get("entry"), 0) * num(order.get("shares"), 0), 2)}
        for order in working_orders
    ]
    book_items = list(open_positions) + reserved
    exposure = sum(num(position.get("notional"), 0) for position in book_items)
    risk_committed = sum(num(position.get("risk_dollars"), 0) for position in book_items)
    category_counts: dict[str, int] = {}
    event_counts: dict[str, int] = {}
    question_counts: dict[str, int] = {}
    for position in book_items:
        category = position.get("category") or "other"
        category_counts[category] = category_counts.get(category, 0) + 1
        event_key = position.get("event_id") or position.get("market_id")
        event_counts[event_key] = event_counts.get(event_key, 0) + 1
        key = _question_key(position.get("question"))
        question_counts[key] = question_counts.get(key, 0) + 1

    exposure_cap = bankroll * cfg.max_total_exposure_pct / 100
    approved: list[str] = []

    for plan in strategy_report["evidence"]:
        checks = [dict(check) for check in common]
        reasons = [check["detail"] for check in common if not check["pass"]]

        def push(name: str, passed: bool, detail: str) -> None:
            checks.append({"name": name, "pass": bool(passed), "detail": detail})
            if not passed:
                reasons.append(detail)

        push("plan_ready", plan["status"] == "plan",
             "strategy returned a complete plan" if plan["status"] == "plan"
             else f"strategy returned {plan['status']}: {plan.get('reason')}")

        scout = next((entry for entry in scout_report["evidence"]
                      if entry["market_id"] == plan["market_id"]), None)
        news = news_by_id.get(plan["market_id"])
        chart = next((entry for entry in charts_report["evidence"]
                      if entry["market_id"] == plan["market_id"]), None)

        if plan["status"] != "plan" or scout is None or chart is None:
            decisions.append({
                "market_id": plan["market_id"],
                "question": plan["question"],
                "verdict": "NOT_REVIEWED",
                "checks": checks,
                "reasons": reasons or ["plan did not reach the risk stage"],
            })
            continue

        quote_ms = _parse_iso(scout.get("source_timestamp"))
        quote_age = (now_ms - quote_ms) / 60_000 if math.isfinite(quote_ms) else float("inf")
        push("fresh_quote", quote_age <= cfg.chart_freshness_minutes,
             f"quote snapshot is {quote_age:.0f} min old (limit {cfg.chart_freshness_minutes})"
             if math.isfinite(quote_age) else "quote has no source timestamp")
        push("fresh_news", (news or {}).get("fresh_count", 0) > 0,
             f"{news['fresh_count']} fresh headline(s)" if (news or {}).get("fresh_count")
             else "no fresh dated source")
        push("news_required", not cfg.require_news or (news or {}).get("fresh_count", 0) > 0,
             "desk requires dated news before a plan" if cfg.require_news else "news not required by config")
        push("event_risk", (news or {}).get("event_risk") != "high",
             f"event risk: {(news or {}).get('event_risk', 'unknown')}")
        push("liquidity", scout["metrics"]["liquidity"] >= cfg.min_liquidity,
             f"liquidity {money(scout['metrics']['liquidity'])} vs floor {money(cfg.min_liquidity)}")
        push("spread", (scout["metrics"]["spread"] or 0) <= cfg.max_spread,
             f"spread {(scout['metrics']['spread'] or 0):.3f} vs limit {cfg.max_spread:g}")
        push("history", chart["data_quality"]["points"] >= cfg.min_history_points,
             f"{chart['data_quality']['points']} bars, {chart['data_quality']['span_hours']}h span")

        chart_conflicts = plan["evidence_used"].get("chart_conflicts") or []
        push("chart_conflicts", len(chart_conflicts) == 0,
             f"charts flagged: {'; '.join(chart_conflicts)}" if chart_conflicts else "no chart conflicts")

        spread = max(num(scout["metrics"]["spread"]), 0.002)
        cost = _cost_per_share(plan["entry"], spread, cfg)
        net_risk = plan["risk_per_share"] + cost
        net_reward = plan["reward_per_share"] - cost
        net_rr = net_reward / net_risk if net_risk > 0 and net_reward > 0 else 0.0

        push("rr_after_costs", plan["gross_rr"] >= cfg.min_net_rr,
             f"gross R:R {plan['gross_rr']:.2f} vs floor {cfg.min_net_rr:g}")
        push("stop_vs_spread", plan["risk_per_share"] >= spread,
             f"stop distance {plan['risk_per_share']:.3f} vs spread {spread:.3f}; "
             "a stop inside the spread is noise")
        push("entry_within_band", plan["entry_distance"] <= cfg.max_entry_distance,
             f"planned entry is {plan['entry_distance']} from the quote (limit {cfg.max_entry_distance:g})")
        push("unresolved_disagreements", len(plan.get("disagreements") or []) == 0,
             "; ".join(plan.get("disagreements") or []) or "agents agree")
        push("net_reward_to_spread", plan["reward_per_share"] / max(spread, 1e-6) >= cfg.min_reward_to_spread,
             f"reward {plan['reward_per_share']:.3f} is "
             f"{plan['reward_per_share'] / max(spread, 1e-6):.1f}× the spread")
        push("net_rr", net_rr >= cfg.min_net_rr,
             f"net R:R {net_rr:.2f} after {cost:.4f}/share of costs vs floor {cfg.min_net_rr:g}")

        risk_budget = bankroll * cfg.max_position_risk_pct / 100
        if (news or {}).get("event_risk") == "medium":
            risk_budget *= 0.5 if cfg.event_risk_medium == "halve" else 1
        remaining_exposure = max(0.0, exposure_cap - exposure)
        daily_cap = bankroll * cfg.max_daily_risk_pct / 100 - risk_committed
        risk_budget = min(risk_budget, daily_cap)

        shares_by_risk = int(risk_budget // net_risk) if net_risk > 0 else 0
        shares_by_exposure = int(remaining_exposure // plan["entry"]) if plan["entry"] > 0 else 0
        liquidity_cap = max(0.0, scout["metrics"]["liquidity"] * 0.01)
        shares_by_liquidity = int(liquidity_cap // plan["entry"]) if plan["entry"] > 0 else 0
        shares_by_cash = int(max(cash, 0.0) // plan["entry"]) if plan["entry"] > 0 else 0
        shares = max(0, min(shares_by_risk, shares_by_exposure, shares_by_liquidity, shares_by_cash))

        push("size", shares >= 1,
             f"{shares} share(s)" if shares >= 1
             else f"size rounds to zero (risk budget {money(max(risk_budget, 0))}, "
                  f"exposure left {money(remaining_exposure)}, cash {money(cash)})")
        min_shares = max(1, int(num(scout.get("order_min_size"), 1)))
        push("order_minimum", shares >= min_shares,
             f"{shares} share(s) vs exchange minimum {min_shares}")
        push("position_cap", len(book_items) + len(approved) < cfg.max_positions,
             f"{len(book_items) + len(approved)} of {cfg.max_positions} position slots used "
             f"({len(working_orders)} working)")

        category = scout.get("category") or "other"
        push("category_concentration", category_counts.get(category, 0) < cfg.max_per_category,
             f"{category_counts.get(category, 0)} of {cfg.max_per_category} allowed {category} positions")
        event_key = scout.get("event_id") or plan["market_id"]
        push("event_concentration", event_counts.get(event_key, 0) < cfg.max_per_event,
             f"{event_counts.get(event_key, 0)} of {cfg.max_per_event} allowed positions on this event")
        push("duplicate_question", question_counts.get(_question_key(plan["question"]), 0) == 0,
             "same question is already in the book or approved in this run")

        failed = [check for check in checks if not check["pass"]]
        verdict = "REJECTED" if failed else "PASSED"
        if verdict == "PASSED" and (news or {}).get("event_risk") == "medium":
            verdict = "REDUCED"

        if verdict in ("PASSED", "REDUCED"):
            notional = rnd(shares * plan["entry"], 2)
            risk_dollars = rnd(shares * plan["risk_per_share"], 2)
            exposure += notional
            risk_committed += risk_dollars
            category_counts[category] = category_counts.get(category, 0) + 1
            event_counts[event_key] = event_counts.get(event_key, 0) + 1
            question_counts[_question_key(plan["question"])] = 1
            approved.append(plan["market_id"])
            decisions.append({
                "market_id": plan["market_id"],
                "question": plan["question"],
                "url": plan.get("url", ""),
                "side": plan["side"],
                "category": category,
                "event_id": event_key,
                "verdict": verdict,
                "checks": checks,
                "reasons": [],
                "risk_notes": ["size halved for medium event risk"] if verdict == "REDUCED" else [],
                "size": {
                    "shares": shares,
                    "entry": plan["entry"],
                    "notional": notional,
                    "risk_dollars": risk_dollars,
                    "max_loss_pct_of_bankroll": rnd(risk_dollars / bankroll * 100, 2),
                    "net_rr": rnd(net_rr, 2),
                    "cost_per_share": rnd(cost),
                    "exposure_after": rnd(exposure, 2),
                    "exposure_limit": rnd(exposure_cap, 2),
                },
                "plan": plan,
            })
        else:
            decisions.append({
                "market_id": plan["market_id"],
                "question": plan["question"],
                "url": plan.get("url", ""),
                "side": plan["side"],
                "category": category,
                "event_id": event_key,
                "verdict": verdict,
                "checks": checks,
                "reasons": reasons,
                "failed_checks": [check["name"] for check in failed],
                "plan": plan,
            })

    passed = [entry for entry in decisions if entry["verdict"] in ("PASSED", "REDUCED")]
    rejected = [entry for entry in decisions if entry["verdict"] == "REJECTED"]
    reviewed = [entry for entry in decisions if entry["verdict"] != "NOT_REVIEWED"]
    status = "complete" if decisions else "needs_data"
    summary = (f"{len(passed)} plan(s) cleared the risk gate, {len(rejected)} rejected, "
               f"{len(decisions) - len(reviewed)} never reached it."
               if decisions else "No plans reached the risk agent.")

    risks = []
    if not passed:
        risks.append("Risk vetoed the whole board: nothing is cleared for a paper entry.")
    for entry in rejected:
        risks.append(f"Rejected {entry.get('side') or 'plan'} on \"{entry['question']}\": "
                     f"{(entry['reasons'] or ['failed check'])[0]}")

    return base_report(
        "risk", now_ms, status, summary, decisions, risks,
        "Boss agent: confirm every stage, then approve, wait or reject.",
        {
            "bankroll": rnd(bankroll, 2),
            "exposure_limit": rnd(exposure_cap, 2),
            "exposure_used": rnd(exposure, 2),
            "risk_committed": rnd(risk_committed, 2),
            "open_positions": len(open_positions),
        "cash": rnd(cash, 2),
            "passed": len(passed),
            "rejected": len(rejected),
            "common_checks": common,
            "limits": {
                "max_positions": cfg.max_positions,
                "max_total_exposure_pct": cfg.max_total_exposure_pct,
                "max_position_risk_pct": cfg.max_position_risk_pct,
                "max_daily_risk_pct": cfg.max_daily_risk_pct,
                "max_per_category": cfg.max_per_category,
                "max_per_event": cfg.max_per_event,
                "min_net_rr": cfg.min_net_rr,
            },
            "policy": ("The gate never relaxes a rule to make a plan pass. Sizes are the smaller of the "
                       "risk budget, the remaining exposure cap and 1% of quoted liquidity. A failed "
                       "check is a veto."),
        },
    )


# --------------------------------------------------------------------------- #
# AGENT 6 — BOSS
# --------------------------------------------------------------------------- #

REQUIRED_AGENTS = ("scout", "news", "charts", "strategy", "risk")


def run_boss(reports: dict[str, Any], cfg: Config, now_ms: int,
             halted_at: str | None = None, source: str = "fixture") -> dict[str, Any]:
    # When the pipeline halts, stages after the halt are *supposed* to be absent. Only the
    # stages that should have run before the halt count as missing.
    if halted_at and halted_at in REQUIRED_AGENTS:
        expected = REQUIRED_AGENTS[:REQUIRED_AGENTS.index(halted_at) + 1]
    else:
        expected = REQUIRED_AGENTS
    missing = [name for name in expected if name not in reports]
    incomplete = [name for name in expected
                  if name in reports and reports[name]["status"] != "complete"]
    integrity: list[dict[str, Any]] = []

    def add(name: str, passed: bool, detail: str) -> None:
        integrity.append({"name": name, "pass": bool(passed), "detail": detail})

    add("pipeline_present", not missing,
        f"missing report(s): {', '.join(missing)}" if missing
        else f"{len(reports)} report(s) present through {halted_at or 'boss'}")
    incomplete_detail = ", ".join(
        f"{name} ({reports[name]['status']})" for name in incomplete
    )
    unexpected_incomplete = [name for name in incomplete if name != halted_at]
    add("stages_complete", not unexpected_incomplete,
        f"incomplete stage(s): {', '.join(incomplete_detail)}"
        if incomplete else "every stage returned complete")
    add("paper_only", cfg.mode == "paper" and cfg.allow_live_orders is False,
        f"mode={cfg.mode}, live orders={cfg.allow_live_orders}")
    add("timestamps", all(
        reports.get(name) and math.isfinite(_parse_iso(reports[name].get("timestamp_utc")))
        for name in REQUIRED_AGENTS), "every report carries an ISO timestamp")

    risk = reports.get("risk")
    passed = [entry for entry in (risk or {}).get("evidence", [])
              if entry["verdict"] in ("PASSED", "REDUCED")]
    rejected = [entry for entry in (risk or {}).get("evidence", [])
                if entry["verdict"] == "REJECTED"]
    strategy = reports.get("strategy") or {}
    plans = [entry for entry in strategy.get("evidence", []) if entry.get("status") == "plan"]
    waits = [entry for entry in strategy.get("evidence", []) if entry.get("status") == "WAIT"]

    disagreements = []
    for plan in plans:
        for item in plan.get("disagreements") or []:
            disagreements.append(f"{plan['question']}: {item}")
    clean = [entry for entry in passed if not (entry.get("plan") or {}).get("disagreements")]

    add("risk_gate_exists", risk is not None,
        f"{len((risk or {}).get('evidence', []))} plan(s) reviewed by risk"
        if risk else "no risk report")
    add("risk_not_blanket_veto", bool(passed),
        f"{len(passed)} plan(s) cleared" if passed else "risk cleared nothing")

    if missing:
        decision = "REJECT"
        explanation = (f"Rejected: the desk is incomplete ({', '.join(missing)}). "
                       "A decision cannot be made on a partial pipeline.")
    elif halted_at:
        decision = "WAIT"
        halted_status = (reports.get(halted_at) or {}).get("status", "needs_data")
        explanation = (f"Halted at {halted_at.upper()} because the stage returned {halted_status}. "
                       "No trade is approved.")
    elif incomplete:
        decision = "WAIT"
        explanation = (f"Stage(s) incomplete ({', '.join(incomplete)}). "
                       "Evidence is missing, so the desk waits instead of guessing.")
    elif not clean:
        if passed:
            decision = "WAIT"
            explanation = (f"{len(passed)} plan(s) cleared risk but every one carries an unresolved "
                           "disagreement. Waiting rather than averaging the conflict.")
        elif rejected:
            decision = "REJECT"
            explanation = (f"Risk rejected every plan ({len(rejected)}). "
                           "No paper entry is authorised.")
        elif plans == [] and waits:
            decision = "WAIT"
            explanation = f"Strategy returned WAIT on all {len(waits)} reviewed market(s). No setup met the rules."
        elif not (risk or {}).get("evidence"):
            decision = "WAIT"
            explanation = "No plan reached the risk gate, so there is nothing to approve."
        else:
            decision = "WAIT"
            explanation = "Nothing cleared the board. Waiting for a complete setup."
    else:
        decision = "APPROVE_FOR_PAPER_TEST"
        explanation = (f"{len(clean)} plan(s) passed every stage with no unresolved disagreement. "
                       "Approved for paper testing only.")

    approved = []
    if decision == "APPROVE_FOR_PAPER_TEST":
        for entry in clean:
            plan = entry["plan"]
            approved.append({
                "market_id": entry["market_id"],
                "question": entry["question"],
                "url": entry.get("url", ""),
                "side": entry["side"],
                "category": entry.get("category"),
                "event_id": entry.get("event_id"),
                "entry": plan["entry"],
                "entry_type": plan.get("entry_type"),
                "quote": plan.get("quote"),
                "invalidation": plan["invalidation"],
                "target": plan["target"],
                "time_limit_utc": plan["time_limit_utc"],
                "shares": entry["size"]["shares"],
                "notional": entry["size"]["notional"],
                "risk_dollars": entry["size"]["risk_dollars"],
                "net_rr": entry["size"]["net_rr"],
                "confidence": plan["confidence"],
                "evidence_used": plan["evidence_used"],
            })

    next_step = ("Re-run when the next data refresh lands, or when the conflicting evidence resolves."
                 if decision == "WAIT" else
                 "Review the failed check names, not the price. Do not loosen limits to force a trade."
                 if decision == "REJECT" else
                 "Log the entry, invalidation, target and time limit in the paper journal "
                 "before the result is known.")

    return base_report(
        "boss", now_ms, "complete", explanation, approved,
        ([f"missing/incomplete: {', '.join(missing + incomplete)}"]
         if missing or incomplete else []),
        next_step,
        {
            "decision": decision,
            "approved": approved,
            "held": [] if decision == "APPROVE_FOR_PAPER_TEST" else passed,
            "integrity": integrity,
            "disagreements": disagreements,
            "counts": {
                "plans": len(plans),
                "waits": len(waits),
                "risk_passed": len(passed),
                "risk_rejected": len(rejected),
                "missing_reports": missing,
                "incomplete_reports": incomplete,
            },
            "data_source": ("SYNTHETIC TEST DATA" if source != "live"
                            else "live public market data"),
            "final_word": ("Paper only. No order endpoint exists in this project. "
                           "Manual human approval is required before any action."),
        },
    )
