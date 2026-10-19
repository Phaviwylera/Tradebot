"""Market data: normalisation, fixtures, synthetic generation, and read-only live feeds.

Everything here is read-only. No function submits an order, signs anything, or touches a wallet.

Sources
-------
fixture : data/fixtures.json, a static snapshot of the synthetic board. Timestamps are stored as
          relative offsets and materialised at load time so the fixture never expires.
test    : the same generator, run in memory with a seed.
live    : public Polymarket Gamma (/markets), CLOB (/prices-history) and Google News RSS.
"""

from __future__ import annotations

import hashlib
import json
import math
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from .config import ROOT, Config

USER_AGENT = "opus-agent-desk/1.0 (paper-trading research; no orders)"
Progress = Callable[[dict[str, Any]], None] | None


# --------------------------------------------------------------------------- #
# small utilities
# --------------------------------------------------------------------------- #

def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def iso(ms: float | int) -> str:
    return (datetime.fromtimestamp(float(ms) / 1000, tz=timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"))


def parse_ms(value: Any) -> float:
    if not value:
        return float("nan")
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return float("nan")


def num(value: Any, fallback: float = 0.0) -> float:
    if value is None or value == "":
        return fallback
    try:
        out = float(value)
    except (TypeError, ValueError):
        return fallback
    return out if math.isfinite(out) else fallback


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def parse_maybe_json(value: Any, fallback: list | None = None) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else (fallback or [])
        except (ValueError, TypeError):
            return fallback or []
    return fallback or []


def median(values: Iterable[float]) -> float:
    seq = sorted(float(v) for v in values if math.isfinite(float(v)))
    if not seq:
        return 0.0
    mid = len(seq) // 2
    return seq[mid] if len(seq) % 2 else (seq[mid - 1] + seq[mid]) / 2


def mad(values: Iterable[float]) -> float:
    seq = [float(v) for v in values if math.isfinite(float(v))]
    if not seq:
        return 0.0
    center = median(seq)
    return 1.4826 * median(abs(v - center) for v in seq)


def robust_z(value: float, values: Iterable[float]) -> float:
    seq = [float(v) for v in values if math.isfinite(float(v))]
    if not seq:
        return 0.0
    center = median(seq)
    spread = mad(seq)
    if spread < 1e-9:
        return 0.0
    return clamp((value - center) / spread, -4, 4)


def _http_get(url: str, *, timeout: int, retries: int, accept: str) -> bytes:
    last: Exception | None = None
    for attempt in range(max(0, retries) + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last = exc
            if attempt < retries:
                continue
    raise RuntimeError(f"request failed for {url.split('?')[0]}: {last}")


def _get_json(url: str, cfg: Config) -> Any:
    raw = _http_get(url, timeout=cfg.request_timeout_s, retries=cfg.retries,
                   accept="application/json")
    return json.loads(raw.decode("utf-8"))


# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #

CATEGORY_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("crypto", ("bitcoin", "btc", "ethereum", " eth", "solana", " sol ", "crypto", "xrp", "doge",
                "binance", "coinbase", "stablecoin", "blockchain")),
    ("sports", ("nfl", "nba", "mlb", "nhl", "ufc", "f1", "premier league", "champions league",
                " vs", "cowboys", "packers", "yankees", "dodgers", "lakers", "celtics", "game",
                "match", "playoff")),
    ("politics", ("president", "senate", "congress", "election", "poll", "governor", "parliament",
                  "minister", "trump", "harris", "democrat", "republican", "shutdown", "impeach",
                  "bill", "tariff")),
    ("econ", ("cpi", "inflation", " fed", "rate cut", "rate hike", "fomc", "gdp", "unemployment",
              "jobs report", "payrolls", "recession", "treasury")),
    ("weather", ("temperature", "rain", "snow", "hurricane", "storm", "weather", "degrees")),
    ("culture", ("oscar", "grammy", "emmy", "movie", "album", "box office", "celebrity",
                 "taylor swift", "netflix", "ticket", "film", "tour")),
]


def infer_category(market: dict[str, Any]) -> str:
    tags = " ".join(
        tag if isinstance(tag, str) else str(tag.get("label") or tag.get("slug") or "")
        for tag in (market.get("tags") or [])
    )
    haystack = " ".join(str(market.get(key) or "") for key in
                        ("category", "event_title", "question", "eventTitle")) + " " + tags
    lowered = f" {haystack.lower()} "
    for category, needles in CATEGORY_RULES:
        if any(needle in lowered for needle in needles):
            return category
    return "other"


def normalize_market(raw: dict[str, Any], reference_ms: int) -> dict[str, Any] | None:
    """Convert a raw Gamma market (or fixture record) into the shape the agents use."""
    if not isinstance(raw, dict):
        return None
    outcomes = [str(item) for item in parse_maybe_json(raw.get("outcomes"))]
    prices = [num(item, float("nan")) for item in parse_maybe_json(raw.get("outcomePrices"))]
    tokens = [str(item) for item in parse_maybe_json(raw.get("clobTokenIds"))]
    if len(outcomes) < 2 or len(tokens) < 2:
        return None

    events = raw.get("events") or []
    event = events[0] if isinstance(events, list) and events and isinstance(events[0], dict) else {}
    best_bid = num(raw.get("bestBid"), float("nan"))
    best_ask = num(raw.get("bestAsk"), float("nan"))
    last = num(raw.get("lastTradePrice"), float("nan"))
    outcome0 = num(prices[0] if prices else None, float("nan"))
    reported_spread = num(raw.get("spread"), float("nan"))

    if math.isfinite(best_bid) and math.isfinite(best_ask) and best_ask > 0:
        price = (best_bid + best_ask) / 2
    elif math.isfinite(last) and 0 < last < 1:
        price = last
    elif math.isfinite(outcome0):
        price = outcome0
    else:
        price = 0.5

    has_quote = (
        math.isfinite(best_bid) and math.isfinite(best_ask)
        and best_ask > best_bid > 0
    )
    if not has_quote and math.isfinite(reported_spread) and reported_spread > 0:
        best_bid = clamp(price - reported_spread / 2, 0.001, 0.999)
        best_ask = clamp(price + reported_spread / 2, 0.001, 0.999)
        has_quote = best_ask > best_bid

    spread = (best_ask - best_bid) if has_quote else None
    # Fixture records carry relative offsets so a static snapshot never expires; the
    # absolute timestamps are only used for live feeds.
    if raw.get("hours_to_end") is not None:
        end_ms = reference_ms + num(raw.get("hours_to_end")) * 3_600_000
    else:
        end_ms = parse_ms(raw.get("endDate") or raw.get("end_date"))
    if raw.get("quote_age_min") is not None:
        updated_ms = reference_ms - num(raw.get("quote_age_min")) * 60_000
    else:
        updated_ms = parse_ms(raw.get("updatedAt") or raw.get("updated_at"))

    market: dict[str, Any] = {
        "id": str(raw.get("id") or raw.get("conditionId") or raw.get("slug") or ""),
        "condition_id": raw.get("conditionId") or "",
        "slug": raw.get("slug") or "",
        "question": raw.get("question") or raw.get("title") or "Untitled market",
        "description": raw.get("description") or "",
        "resolution_source": raw.get("resolutionSource") or "",
        "event_id": str(event.get("id") or raw.get("eventId") or raw.get("id") or ""),
        "event_title": event.get("title") or raw.get("event_title") or raw.get("question") or "Untitled event",
        "category": str(raw.get("category") or "").lower(),
        "outcomes": outcomes[:2],
        "tokens": tokens[:2],
        "price": clamp(price, 0.001, 0.999),
        "has_quote": has_quote,
        "best_bid": best_bid if has_quote else None,
        "best_ask": best_ask if has_quote else None,
        "spread": spread,
        "liquidity": num(raw.get("liquidityNum") or raw.get("liquidity")),
        "volume_24h": num(raw.get("volume24hr") or raw.get("volume_24h")),
        "volume_1w": num(raw.get("volume1wk") or raw.get("volume_1w")),
        "volume_total": num(raw.get("volumeNum") or raw.get("volume")),
        "move_1h": num(raw.get("oneHourPriceChange") or raw.get("move_1h")),
        "move_24h": num(raw.get("oneDayPriceChange") or raw.get("move_24h")),
        "move_1w": num(raw.get("oneWeekPriceChange") or raw.get("move_1w")),
        "open_interest": num(event.get("openInterest") or raw.get("open_interest")),
        "end_ms": end_ms,
        "end_date": iso(end_ms) if math.isfinite(end_ms) else None,
        "updated_at": iso(updated_ms) if math.isfinite(updated_ms) else None,
        "accepting_orders": raw.get("acceptingOrders", True) is not False and raw.get("closed") is not True,
        "closed": raw.get("closed") is True,
        "enable_order_book": raw.get("enableOrderBook", True) is not False,
        "order_min_size": num(raw.get("orderMinSize"), 5),
        "tick_size": num(raw.get("orderPriceMinTickSize"), 0.001),
        "fees_enabled": raw.get("feesEnabled") is True,
        "fee_rate": num((raw.get("feeSchedule") or {}).get("rate") if isinstance(raw.get("feeSchedule"), dict) else None),
        "neg_risk": raw.get("negRisk") is True,
        "featured": raw.get("featured") is True,
        "comment_count": num(event.get("commentCount") or raw.get("comment_count")),
        "synthetic": bool(raw.get("synthetic")) or bool(raw.get("demo")),
        "regime": raw.get("regime") or raw.get("demoRegime"),
        "news_count": raw.get("news_count", raw.get("demoNews")),
        "event_risk_hint": raw.get("event_risk", raw.get("demoEventRisk")),
        "raw": raw,
    }

    market["category"] = market["category"] or infer_category({
        **raw,
        "event_title": market["event_title"],
        "question": market["question"],
    })
    if market["category"] in ("", "other") and market["synthetic"]:
        market["category"] = str(raw.get("category") or "other")

    market["yes"] = {
        "label": market["outcomes"][0],
        "token": market["tokens"][0],
        "price": market["price"],
        "bid": market["best_bid"],
        "ask": market["best_ask"],
    }
    market["no"] = {
        "label": market["outcomes"][1],
        "token": market["tokens"][1],
        "price": clamp(1 - market["price"], 0.001, 0.999),
        "bid": clamp(1 - market["best_ask"], 0.001, 0.999) if has_quote else None,
        "ask": clamp(1 - market["best_bid"], 0.001, 0.999) if has_quote else None,
    }
    market["url"] = f"https://polymarket.com/market/{market['slug']}" if market["slug"] else ""
    return market


# --------------------------------------------------------------------------- #
# deterministic synthetic board
# --------------------------------------------------------------------------- #

class Rng:
    """mulberry32 + Box-Muller, so fixture and test data are reproducible across machines."""

    def __init__(self, seed: int) -> None:
        self.state = int(seed) & 0xFFFFFFFF

    def random(self) -> float:
        # mulberry32. The final `t ^ (t >> 14)` matters: xoring a value with itself
        # would collapse the stream to a constant and hang every `pick()` loop.
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.state
        t = ((t ^ (t >> 15)) * (1 | t)) & 0xFFFFFFFF
        t = (t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = t ^ (t >> 14)
        return (t & 0xFFFFFFFF) / 4294967296

    def normal(self) -> float:
        u = max(self.random(), 1e-9)
        v = max(self.random(), 1e-9)
        return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)

    def between(self, lo: float, hi: float) -> float:
        return lo + self.random() * (hi - lo)

    def integer(self, lo: int, hi: int) -> int:
        return lo + int(self.random() * (hi - lo + 1))

    def pick(self, items):
        return items[min(len(items) - 1, int(self.random() * len(items)))]


TEAM_POOLS = [
    ["Cowboys", "Packers", "Chiefs", "Bills", "49ers", "Ravens", "Eagles", "Lions"],
    ["Yankees", "Dodgers", "Cubs", "Mets", "Astros", "Braves"],
    ["Celtics", "Lakers", "Knicks", "Heat", "Nuggets", "Warriors"],
    ["Arsenal", "Chelsea", "Liverpool", "City", "Spurs", "United"],
    ["Maple Leafs", "Bruins", "Rangers", "Oilers", "Canadiens"],
]
POLITICS = [
    "the Senate pass the budget bill", "the government shut down",
    "the incumbent lead the next poll", "the bill clear the House",
    "the coalition win the election", "the nominee be confirmed",
    "the tariff package be signed", "the recount be certified",
]
CRYPTO = [("BTC", 62000, 130000), ("ETH", 2100, 5400), ("SOL", 90, 260), ("XRP", 0.4, 1.6)]
ECON = [
    "Core CPI come in above 3.0%", "the Fed cut rates at the next meeting",
    "the Fed hold rates at the next meeting", "payrolls beat 200k",
    "GDP growth top 2.5%", "unemployment print below 4.2%",
]
CULTURE = [
    "the film open above $50M", "the album debut at number one", "the show win best drama",
    "the game sell 10M copies", "the tour add a second date",
]
WEATHER = [
    "the high in New York top 70F", "rain fall in London",
    "the storm be upgraded to a hurricane", "snow fall in Chicago",
]
CATEGORY_PLAN = [("sports", 175), ("politics", 115), ("crypto", 95), ("econ", 65),
                 ("culture", 40), ("weather", 20), ("other", 10)]


def _make_question(rng: Rng, category: str, reference_ms: int) -> tuple[str, str, list[str]]:
    day = datetime.fromtimestamp((reference_ms + rng.between(2, 40) * 86_400_000) / 1000, tz=timezone.utc)
    date_label = day.strftime("%b %-d") if hasattr(day, "strftime") else f"{day:%b} {day.day}"
    if category == "sports":
        pool = rng.pick(TEAM_POOLS)
        a = rng.pick(pool)
        b = rng.pick(pool)
        while b == a:
            b = rng.pick(pool)
        return f"{a} vs. {b}: {a} to win", f"{a} vs. {b}", [a, b]
    if category == "politics":
        return f"Will {rng.pick(POLITICS)} by {date_label}?", "Politics", ["Yes", "No"]
    if category == "crypto":
        symbol, lo, hi = rng.pick(CRYPTO)
        level = round(rng.between(lo, hi) / 500) * 500 or round(rng.between(lo, hi))
        direction = "above" if rng.random() > 0.5 else "below"
        shown = f"${level:,.0f}" if level >= 100 else f"${level:.2f}"
        return f"Will {symbol} close {direction} {shown} on {date_label}?", f"{symbol} price on {date_label}", ["Yes", "No"]
    if category == "econ":
        return f"Will {rng.pick(ECON)}?", "US macro", ["Yes", "No"]
    if category == "weather":
        return f"Will {rng.pick(WEATHER)} on {date_label}?", "Weather", ["Yes", "No"]
    return f"Will {rng.pick(CULTURE)} by {date_label}?", "Culture", ["Yes", "No"]


def generate_universe(reference_ms: int, seed: int = 20261019) -> dict[str, Any]:
    """Generate the 520-market synthetic board used by fixture and test modes."""
    rng = Rng(seed)
    markets: list[dict[str, Any]] = []
    index = 0
    for category, count in CATEGORY_PLAN:
        for _ in range(count):
            question, event, outcomes = _make_question(rng, category, reference_ms)
            hot = index % 22 == 5
            price = rng.between(0.18, 0.82) if hot else rng.between(0.04, 0.96)
            direction = 1 if rng.random() > 0.45 else -1
            move_24h = direction * (rng.between(0.09, 0.28) if hot else rng.between(0.002, 0.06))
            move_1h = move_24h * rng.between(0.15, 0.9)
            spread = rng.between(0.002, 0.014) if hot else rng.between(0.002, 0.075)
            liquidity = (rng.between(45_000, 700_000) if hot
                         else math.exp(rng.normal() * 1.05 + 8.9))
            volume_24h = liquidity * (rng.between(0.35, 1.6) if hot else rng.between(0.03, 0.7))
            hours_to_end = rng.between(3, 60) if hot else rng.between(0.4, 40 * 24)
            regime = ((("up" if direction > 0 else "down") if rng.random() > 0.5 else "breakout")
                      if hot else rng.pick(["range", "range", "up", "down", "breakout"]))
            news_count = rng.integer(2, 4) if hot else rng.integer(0, 3)
            event_risk = (rng.pick(["low", "medium", "medium", "high"])
                          if category in ("econ", "politics")
                          else rng.pick(["low", "low", "low", "medium"]))
            bid = clamp(price - spread / 2, 0.002, 0.998)
            ask = clamp(price + spread / 2, 0.002, 0.998)
            quote_age_min = rng.between(1, 6) if hot else rng.between(2, 90)
            markets.append({
                "id": f"test-{index + 1:04d}",
                "conditionId": f"0xtest{index}",
                "slug": f"test-market-{index + 1}",
                "question": question,
                "description": ("SYNTHETIC TEST MARKET. This question, its prices and its volume were "
                                "generated by the desk. It does not describe a real Polymarket contract and "
                                "must not be read as a forecast."),
                "resolutionSource": "https://example.com/test-data",
                "outcomes": json.dumps(outcomes),
                "outcomePrices": json.dumps([round(price, 4), round(1 - price, 4)]),
                "clobTokenIds": json.dumps([f"test-yes-{index + 1}", f"test-no-{index + 1}"]),
                "events": [{
                    "id": f"test-event-{category}-{index // 3}",
                    "title": event,
                    "commentCount": rng.integer(0, 400),
                    "openInterest": liquidity * rng.between(0.1, 1.5),
                }],
                "liquidityNum": round(liquidity, 2),
                "volume24hr": round(volume_24h, 2),
                "volume1wk": round(volume_24h * rng.between(1.5, 12), 2),
                "volumeNum": round(volume_24h * rng.between(2, 30), 2),
                "oneHourPriceChange": round(move_1h, 4),
                "oneDayPriceChange": round(move_24h, 4),
                "oneWeekPriceChange": round(move_24h * rng.between(0.6, 2.4), 4),
                "lastTradePrice": round(price, 4),
                "bestBid": round(bid, 4),
                "bestAsk": round(ask, 4),
                "spread": round(spread, 4),
                "endDate": iso(reference_ms + hours_to_end * 3_600_000),
                "updatedAt": iso(reference_ms - quote_age_min * 60_000),
                "quote_age_min": round(quote_age_min, 2),
                "acceptingOrders": True,
                "closed": False,
                "enableOrderBook": True,
                "orderMinSize": 5,
                "orderPriceMinTickSize": 0.001,
                "feesEnabled": rng.random() > 0.5,
                "feeSchedule": {"rate": 0.02},
                "category": category,
                "synthetic": True,
                "regime": regime,
                "news_count": news_count,
                "event_risk": event_risk,
                "hours_to_end": round(hours_to_end, 3),
            })
            index += 1

    return {
        "generated_at": iso(reference_ms),
        "seed": seed,
        "label": "SYNTHETIC TEST DATA",
        "note": "Generated board. Not a real market and not a forecast.",
        "markets": markets,
    }


def materialize(payload: dict[str, Any], reference_ms: int) -> list[dict[str, Any]]:
    """Turn fixture/generator records into normalised markets with fresh timestamps."""
    markets = []
    for raw in payload.get("markets", []):
        market = normalize_market(raw, reference_ms)
        if market is None:
            continue
        market["synthetic"] = True
        market["regime"] = raw.get("regime") or market["regime"]
        market["news_count"] = raw.get("news_count", market["news_count"])
        market["event_risk_hint"] = raw.get("event_risk") or market["event_risk_hint"]
        market["category"] = str(raw.get("category") or market["category"])
        markets.append(market)
    return markets


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #

def load_fixtures(cfg: Config, reference_ms: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    path = Path(cfg.fixture_file)
    if not path.is_absolute():
        path = ROOT / path
    if not path.exists():
        raise RuntimeError(f"fixture file not found: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    markets = materialize(payload, reference_ms)
    return markets, {
        "source": "fixture",
        "fetched_at": iso(reference_ms),
        "note": f"{cfg.fixture_file} · {len(markets)} synthetic markets · TEST DATA",
        "synthetic": True,
        "label": payload.get("label", "SYNTHETIC TEST DATA"),
    }


def build_fixtures(reference_ms: int, seed: int = 20261019, out_path: str | Path | None = None) -> dict[str, Any]:
    payload = generate_universe(reference_ms, seed)
    if out_path:
        target = Path(out_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    return payload


# --------------------------------------------------------------------------- #
# synthetic series + headlines
# --------------------------------------------------------------------------- #

def synthesize_history(market: dict[str, Any], reference_ms: int, seed: int | None = None) -> list[dict[str, float]]:
    """24h of 15-minute closes, walked backwards from the quoted price."""
    regime = market.get("regime") or "range"
    base_seed = seed if seed is not None else (
        sum(ord(ch) for ch in str(market["id"])) * 7919
    )
    rng = Rng(base_seed)
    points = 96
    step_ms = 15 * 60_000
    noise = 0.0032 if regime == "range" else 0.0045
    price = clamp(market["price"], 0.03, 0.97)
    series: list[dict[str, float]] = []
    value = price
    for index in range(points - 1, -1, -1):
        series.append({"t": reference_ms - (points - 1 - index) * step_ms,
                       "p": round(value, 4)})
        if regime == "up":
            drift = 0.0018
        elif regime == "down":
            drift = -0.0018
        elif regime == "breakout":
            drift = 0.0002 if index < points * 0.62 else 0.009
        else:
            drift = (price - value) * 0.05
        value = clamp(value - drift - rng.normal() * noise, 0.02, 0.98)
    series.reverse()
    return series


HEADLINE_POOL = {
    "crypto": [
        "Spot flows turn positive as large wallets add exposure",
        "Exchange reserves slip to a fresh monthly low",
        "Analysts split on whether the move has confirmation",
    ],
    "econ": [
        "Traders trim odds ahead of the next data print",
        "Revised consensus puts the headline figure slightly higher",
        "Officials repeat that policy stays data dependent",
    ],
    "politics": [
        "Committee vote scheduled for later this week",
        "New polling shows the gap narrowing",
        "Leadership signals the timeline may slip",
    ],
    "sports": [
        "Starting lineup confirmed after a limited practice week",
        "Weather forecast shifts wind direction for kickoff",
        "Coach says the game plan is unchanged",
    ],
    "culture": [
        "Early tracking estimates land above expectations",
        "Release schedule moves by one week",
        "Festival jury announces its shortlist",
    ],
    "weather": [
        "Forecast model nudges the probability band upward",
        "Local stations issue an advisory for the region",
        "Updated guidance keeps the same general pattern",
    ],
    "other": [
        "Desk note flags thin liquidity around the event window",
        "Participants report wider quotes than yesterday",
    ],
}


def synthesize_news(market: dict[str, Any], reference_ms: int, max_items: int = 8) -> list[dict[str, Any]]:
    count = int(num(market.get("news_count"), 0))
    if count <= 0:
        return []
    seed = sum(ord(ch) for ch in str(market["id"])) * 104_729
    rng = Rng(seed)
    pool = HEADLINE_POOL.get(market["category"], HEADLINE_POOL["other"])
    risk = market.get("event_risk_hint") or "low"
    items = []
    for index in range(min(count, max_items)):
        age_min = rng.between(5, 20) * (index + 1)
        title = f"{market['event_title']}: {pool[index % len(pool)]}"
        items.append({
            "title": title,
            "link": f"https://example.com/test-data/{market['id']}/{index}",
            "source": "TEST DATA wire (synthetic)",
            "sourceUrl": "https://example.com/test-data",
            "published_ms": reference_ms - age_min * 60_000,
            "published_at": iso(reference_ms - age_min * 60_000),
            "synthetic": True,
            "event_risk_hint": risk if index == 0 else "low",
        })
    return items


# --------------------------------------------------------------------------- #
# live feeds (read-only)
# --------------------------------------------------------------------------- #

def fetch_live_universe(cfg: Config, progress: Progress = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    markets: list[dict[str, Any]] = []
    seen: set[str] = set()
    offset = 0
    pages = 0
    reference = now_ms()
    while len(markets) < cfg.universe_limit and pages < 10:
        limit = min(cfg.page_size, cfg.universe_limit - len(markets))
        params = urllib.parse.urlencode({
            "active": "true", "closed": "false", "limit": str(limit), "offset": str(offset),
            "order": "volume24hr", "ascending": "false",
        })
        page = _get_json(f"{cfg.gamma_base}/markets?{params}", cfg)
        if not isinstance(page, list) or not page:
            break
        for raw in page:
            market = normalize_market(raw, reference)
            if market is None or market["id"] in seen:
                continue
            seen.add(market["id"])
            markets.append(market)
        offset += len(page)
        pages += 1
        if progress:
            progress({"loaded": len(markets), "target": cfg.universe_limit, "page": pages})
        if len(page) < limit:
            break
    return markets, {
        "source": "live",
        "fetched_at": iso(reference),
        "note": f"Gamma /markets ordered by 24h volume, {pages} page(s)",
        "synthetic": False,
        "label": "LIVE PUBLIC DATA",
    }


def fetch_live_history(cfg: Config, market: dict[str, Any]) -> list[dict[str, float]]:
    token = (market.get("tokens") or [None])[0]
    if not token:
        raise RuntimeError("market has no CLOB token id")
    for interval, fidelity in ((cfg.interval, cfg.fidelity_minutes), ("1w", 60)):
        params = urllib.parse.urlencode({"market": token, "interval": interval, "fidelity": str(fidelity)})
        body = _get_json(f"{cfg.clob_base}/prices-history?{params}", cfg)
        points = body.get("history") if isinstance(body, dict) else None
        if points:
            parsed = [{"t": num(point.get("t")) * 1000, "p": num(point.get("p"), float("nan"))}
                      for point in points if isinstance(point, dict)]
            clean = sorted((point for point in parsed
                            if math.isfinite(point["p"]) and point["t"] > 0), key=lambda p: p["t"])
            if clean:
                return clean
    raise RuntimeError("CLOB price history returned no usable points")


def fetch_live_news(cfg: Config, market: dict[str, Any]) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({
        "q": build_news_query(market), "hl": "en-US", "gl": "US", "ceid": "US:en",
    })
    raw = _http_get(f"{cfg.news_base}?{params}", timeout=cfg.request_timeout_s,
                    retries=cfg.retries, accept="application/rss+xml, text/xml, */*")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise RuntimeError(f"news feed returned invalid XML: {exc}") from exc
    items = []
    for node in root.iter("item"):
        title = (node.findtext("title") or "").strip()
        if not title:
            continue
        source_node = node.find("source")
        published = (node.findtext("pubDate") or "").strip()
        published_ms = _parse_rfc822(published)
        items.append({
            "title": " ".join(title.split()),
            "link": (node.findtext("link") or "").strip(),
            "source": (source_node.text or "").strip() if source_node is not None else "",
            "sourceUrl": source_node.get("url", "") if source_node is not None else "",
            "published_ms": published_ms,
            "published_at": iso(published_ms) if math.isfinite(published_ms) else None,
            "synthetic": False,
        })
        if len(items) >= cfg.max_items:
            break
    return items


def _parse_rfc822(text: str) -> float:
    if not text:
        return float("nan")
    from email.utils import parsedate_to_datetime
    try:
        parsed = parsedate_to_datetime(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp() * 1000
    except (TypeError, ValueError):
        return float("nan")


STOP_WORDS = {
    "will", "the", "a", "an", "by", "on", "in", "at", "to", "of", "and", "or", "for",
    "market", "close", "above", "below", "yes", "no", "this", "that", "next", "be",
}


def build_news_query(market: dict[str, Any]) -> str:
    import re
    text = f"{market.get('event_title') or ''} {market.get('question') or ''}"
    cleaned = re.sub(r"[^a-zA-Z0-9$%.\s-]", " ", text)
    words = [word for word in cleaned.split() if len(word) > 1 and word.lower() not in STOP_WORDS]
    unique = list(dict.fromkeys(words))[:7]
    return " ".join(unique)


def fetch_history(cfg: Config, market: dict[str, Any], reference_ms: int) -> dict[str, Any]:
    if cfg.source == "live":
        points = fetch_live_history(cfg, market)
        source = f"Polymarket CLOB /prices-history ({cfg.interval})"
    else:
        points = synthesize_history(market, reference_ms)
        source = "synthetic 15-minute series"
    return {"points": points, "source": source, "outcomes": market["outcomes"],
            "fetched_at": iso(reference_ms)}


def fetch_news(cfg: Config, market: dict[str, Any], reference_ms: int) -> list[dict[str, Any]]:
    if cfg.source == "live":
        return fetch_live_news(cfg, market)
    return synthesize_news(market, reference_ms, cfg.max_items)


def load_universe(cfg: Config, reference_ms: int, progress: Progress = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if cfg.source == "live":
        return fetch_live_universe(cfg, progress)
    if cfg.source == "test":
        payload = generate_universe(reference_ms, cfg.test_seed)
        markets = materialize(payload, reference_ms)
        return markets, {
            "source": "test",
            "fetched_at": iso(reference_ms),
            "note": f"seeded synthetic board (seed {cfg.test_seed})",
            "synthetic": True,
            "label": "SYNTHETIC TEST DATA",
        }
    return load_fixtures(cfg, reference_ms)


def contract_hashes(directory: str | Path) -> dict[str, str]:
    """SHA-256 of each agent contract, recorded in every run for auditability."""
    base = Path(directory)
    if not base.is_absolute():
        base = ROOT / base
    hashes = {}
    for name in ("scout", "news", "charts", "strategy", "risk", "boss"):
        path = base / f"{name}.md"
        if path.exists():
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    return hashes
