"""Simulated paper book.

This module is the only place that "fills" anything, and every fill is fictional: shares are
credited at the quoted price, cash is deducted from a fixed starting balance, and nothing is
ever sent to an exchange. There is no wallet, key, signature or order client here.

The book is deliberately simple and auditable:

  * one open position (or resting order) per market,
  * entries only from the Boss's APPROVE list and the Risk-approved size,
  * entries at the quote fill now; conditional pullbacks, retests and reversals rest as
    limit/stop orders and fill only when the market trades to the level,
  * exits at the stop, the target, market resolution or the plan's time limit,
  * cash can never go negative; size is capped by the cash actually available,
  * the starting balance is never topped up, so the equity curve is honest.

State lives in ``data/paper-ledger.json`` (committed by the scheduled runner) and a read-only
snapshot is published to ``public/reports/ledger.json`` for the dashboard.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from . import data
from .config import ROOT, Config

LEDGER_VERSION = 1
EQUITY_POINTS_MAX = 600
CLOSED_KEEP = 200


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #

def ledger_path(cfg: Config) -> Path:
    path = Path(cfg.ledger_file)
    return path if path.is_absolute() else ROOT / path


def _write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(path.parent), prefix=".ledger-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def new_ledger(cfg: Config, now_ms: float) -> dict[str, Any]:
    start = round(float(cfg.starting_cash), 2)
    return {
        "version": LEDGER_VERSION,
        "mode": "paper",
        "currency": "USD",
        "starting_cash": start,
        "cash": start,
        "created_utc": data.iso(now_ms),
        "updated_utc": data.iso(now_ms),
        "realized_pnl": 0.0,
        "positions": [],
        "orders": [],
        "trades": [],
        "equity_curve": [{"t": data.iso(now_ms), "equity": start}],
        "counters": {"next_trade": 1, "next_order": 1},
        "policy": "simulated fills at quoted prices; no broker, wallet or order client",
    }


def load_ledger(cfg: Config, now_ms: float) -> dict[str, Any]:
    path = ledger_path(cfg)
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict) and payload.get("version") == LEDGER_VERSION:
            payload.setdefault("positions", [])
            payload.setdefault("orders", [])
            payload.setdefault("trades", [])
            payload.setdefault("equity_curve", [])
            payload.setdefault("counters", {"next_trade": len(payload.get("trades", [])) + 1,
                                            "next_order": 1})
            payload["counters"].setdefault("next_order", 1)
            payload.setdefault("realized_pnl", 0.0)
            payload.setdefault("starting_cash", round(float(cfg.starting_cash), 2))
            return payload
    return new_ledger(cfg, now_ms)


# --------------------------------------------------------------------------- #
# prices and math
# --------------------------------------------------------------------------- #

def _parse_utc(value: Any) -> float:
    if not value:
        return float("nan")
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp.timestamp() * 1000
    except (TypeError, ValueError):
        return float("nan")


def price_map(markets: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """market_id -> the few fields the book needs to mark and settle a position."""
    prices: dict[str, dict[str, Any]] = {}
    for market in markets or []:
        market_id = str(market.get("id") or "")
        price = market.get("price")
        if not market_id or price is None:
            continue
        try:
            value = float(price)
        except (TypeError, ValueError):
            continue
        if not 0 <= value <= 1:
            continue
        prices[market_id] = {
            "price": value,
            "closed": bool(market.get("closed")),
            "accepting_orders": market.get("accepting_orders", True) is not False,
            "url": market.get("url") or "",
            "question": market.get("question") or "",
        }
    return prices


def _position_value(position: dict[str, Any]) -> float:
    price = float(position.get("last_price") or position.get("entry") or 0)
    return round(float(position.get("shares") or 0) * price, 2)


def _equity(ledger: dict[str, Any]) -> float:
    cash = float(ledger.get("cash") or 0)
    return round(cash + sum(_position_value(position) for position in ledger.get("positions") or []), 2)


# --------------------------------------------------------------------------- #
# state transitions
# --------------------------------------------------------------------------- #

def settle(ledger: dict[str, Any], markets: Iterable[dict[str, Any]], now_ms: float) -> list[dict[str, Any]]:
    """Mark every open position and close the ones that hit a stop, target, resolution or limit."""
    quotes = price_map(markets)
    stamp = data.iso(now_ms)
    remaining: list[dict[str, Any]] = []
    closed: list[dict[str, Any]] = []

    for position in ledger.get("positions") or []:
        market = quotes.get(str(position.get("market_id")))
        if market:
            price = market["price"]
            position["last_price"] = round(price, 4)
            position["last_mark_utc"] = stamp
            if market.get("url"):
                position["url"] = market["url"]
            if market.get("question"):
                position["question"] = market["question"]
        else:
            price = float(position.get("last_price") or position.get("entry") or 0)

        stop = float(position.get("stop") or 0)
        target = float(position.get("target") or 0)
        limit_ms = _parse_utc(position.get("time_limit_utc"))
        reason = None
        exit_price = price

        if stop and price <= stop:
            reason = "stop"
            exit_price = min(price, stop)
        elif target and price >= target:
            reason = "target"
            exit_price = target
        elif market and (market["closed"] or not market["accepting_orders"]):
            reason = "resolved"
            exit_price = price
        elif limit_ms == limit_ms and now_ms >= limit_ms:
            reason = "time_limit"
            exit_price = price

        if reason is None:
            remaining.append(position)
            continue

        shares = float(position.get("shares") or 0)
        cost = float(position.get("cost_basis") or 0)
        proceeds = round(shares * exit_price, 2)
        pnl = round(proceeds - cost, 2)
        ledger["cash"] = round(float(ledger.get("cash") or 0) + proceeds, 2)
        ledger["realized_pnl"] = round(float(ledger.get("realized_pnl") or 0) + pnl, 2)
        trade = {
            **position,
            "exit": round(exit_price, 4),
            "exit_reason": reason,
            "closed_utc": stamp,
            "proceeds": proceeds,
            "pnl": pnl,
            "return_pct": round((pnl / cost) * 100, 2) if cost else 0.0,
            "held_hours": round((now_ms - float(_parse_utc(position.get("opened_utc")) or now_ms)) / 3_600_000, 2),
        }
        ledger.setdefault("trades", []).append(trade)
        closed.append(trade)

    ledger["positions"] = remaining
    if len(ledger.get("trades") or []) > CLOSED_KEEP:
        ledger["trades"] = ledger["trades"][-CLOSED_KEEP:]
    return closed



def fill_orders(ledger: dict[str, Any], markets: Iterable[dict[str, Any]], now_ms: float) -> list[dict[str, Any]]:
    """Fill resting paper orders when the market trades through their level.

    A pullback/retest order is a *limit* buy below the quote; it fills only after the quoted
    price falls to the entry. A reversal order sits above the quote and fills only after the
    price rises through it. The fill uses the order's level (or the worse gap price for a stop
    entry), never the optimistic side. Orders expire at the plan's time limit.
    """
    quotes = price_map(markets)
    stamp = data.iso(now_ms)
    filled: list[dict[str, Any]] = []
    working: list[dict[str, Any]] = []
    counter = int((ledger.get("counters") or {}).get("next_trade") or 1)

    for order in ledger.get("orders") or []:
        limit_ms = _parse_utc(order.get("time_limit_utc"))
        if limit_ms == limit_ms and now_ms >= limit_ms:
            continue
        market = quotes.get(str(order.get("market_id") or ""))
        entry = float(order.get("entry") or 0)
        if not market or entry <= 0:
            working.append(order)
            continue
        price = market["price"]
        order["last_price"] = round(price, 4)
        order["last_mark_utc"] = stamp
        trigger = order.get("trigger") or "limit"
        ready = price <= entry + 1e-9 if trigger == "limit" else price >= entry - 1e-9
        if not ready:
            working.append(order)
            continue

        cash = float(ledger.get("cash") or 0)
        shares = int(min(int(order.get("shares") or 0), cash // entry)) if entry > 0 else 0
        if shares < 1:
            working.append(order)
            continue
        fill_price = entry if trigger == "limit" else max(entry, price)
        cost = round(shares * fill_price, 2)
        if cost > cash + 1e-9:
            shares -= 1
            cost = round(shares * fill_price, 2)
        if shares < 1 or cost > cash + 1e-9:
            working.append(order)
            continue

        ledger["cash"] = round(cash - cost, 2)
        position = {
            "trade_id": f"P{int(now_ms)}-{counter:03d}",
            "market_id": order.get("market_id"),
            "question": order.get("question") or market.get("question") or "",
            "url": order.get("url") or market.get("url") or "",
            "side": order.get("side") or "",
            "category": order.get("category") or "other",
            "event_id": order.get("event_id") or order.get("market_id"),
            "entry": round(fill_price, 4),
            "shares": shares,
            "cost_basis": cost,
            "risk_dollars": round(float(order.get("risk_dollars") or 0), 2),
            "stop": round(float(order.get("stop") or 0), 4),
            "target": round(float(order.get("target") or 0), 4),
            "opened_utc": stamp,
            "time_limit_utc": order.get("time_limit_utc"),
            "last_price": round(price, 4),
            "last_mark_utc": stamp,
            "status": "OPEN",
            "filled_order": order.get("order_id"),
        }
        ledger.setdefault("positions", []).append(position)
        filled.append(position)
        counter += 1

    ledger["orders"] = working
    ledger.setdefault("counters", {})["next_trade"] = counter
    return filled


def open_from_run(ledger: dict[str, Any], boss_report: dict[str, Any], now_ms: float) -> list[dict[str, Any]]:
    """Queue or open paper entries from the Boss's approved list.

    Entries at the current quote fill immediately. Conditional pullbacks, retests and reversals
    become resting orders and only fill when the market trades to the level (see ``fill_orders``).
    Size is capped by the cash actually available; the starting balance is never topped up.
    """
    meta = (boss_report or {}).get("meta") or {}
    ledger["queued_this_run"] = []
    if meta.get("decision") != "APPROVE_FOR_PAPER_TEST":
        return []

    open_ids = {str(position.get("market_id")) for position in ledger.get("positions") or []}
    order_ids = {str(order.get("market_id")) for order in ledger.get("orders") or []}
    stamp = data.iso(now_ms)
    opened: list[dict[str, Any]] = []
    counter = int((ledger.get("counters") or {}).get("next_trade") or 1)
    order_counter = int((ledger.get("counters") or {}).get("next_order") or 1)

    for item in meta.get("approved") or []:
        market_id = str(item.get("market_id") or "")
        entry = float(item.get("entry") or 0)
        if not market_id or market_id in open_ids or market_id in order_ids or entry <= 0:
            continue

        quote_raw = item.get("quote")
        quote = float(quote_raw) if quote_raw not in (None, "") else entry
        entry_type = str(item.get("entry_type") or "breakout")
        marketable = entry_type == "breakout" or abs(entry - quote) <= 0.0015

        if not marketable:
            trigger = "limit" if entry < quote else "stop"
            order = {
                "order_id": f"W{int(now_ms)}-{order_counter:03d}",
                "market_id": market_id,
                "question": item.get("question") or "",
                "url": item.get("url") or "",
                "side": item.get("side") or "",
                "category": item.get("category") or "other",
                "event_id": item.get("event_id") or market_id,
                "entry_type": entry_type,
                "trigger": trigger,
                "entry": round(entry, 4),
                "quote_at_approval": round(quote, 4),
                "stop": round(float(item.get("invalidation") or 0), 4),
                "target": round(float(item.get("target") or 0), 4),
                "shares": int(item.get("shares") or 0),
                "risk_dollars": round(float(item.get("risk_dollars") or 0), 2),
                "time_limit_utc": item.get("time_limit_utc"),
                "created_utc": stamp,
                "last_mark_utc": stamp,
                "status": "WORKING",
            }
            ledger.setdefault("orders", []).append(order)
            ledger["queued_this_run"].append(order)
            order_ids.add(market_id)
            order_counter += 1
            continue

        cash = float(ledger.get("cash") or 0)
        if cash < entry:
            continue
        planned = int(item.get("shares") or 0)
        shares = max(0, min(planned, int(cash // entry)))
        if shares < 1:
            continue
        cost = round(shares * entry, 2)
        if cost > cash + 1e-9:
            shares -= 1
            cost = round(shares * entry, 2)
        if shares < 1 or cost > cash + 1e-9:
            continue

        ledger["cash"] = round(cash - cost, 2)
        position = {
            "trade_id": f"P{int(now_ms)}-{counter:03d}",
            "market_id": market_id,
            "question": item.get("question") or "",
            "url": item.get("url") or "",
            "side": item.get("side") or "",
            "category": item.get("category") or "other",
            "event_id": item.get("event_id") or market_id,
            "entry": round(entry, 4),
            "shares": shares,
            "cost_basis": cost,
            "risk_dollars": round(float(item.get("risk_dollars") or 0), 2),
            "stop": round(float(item.get("invalidation") or 0), 4),
            "target": round(float(item.get("target") or 0), 4),
            "opened_utc": stamp,
            "time_limit_utc": item.get("time_limit_utc"),
            "last_price": round(entry, 4),
            "last_mark_utc": stamp,
            "status": "OPEN",
        }
        ledger.setdefault("positions", []).append(position)
        open_ids.add(market_id)
        opened.append(position)
        counter += 1

    ledger.setdefault("counters", {})["next_trade"] = counter
    ledger["counters"]["next_order"] = order_counter
    return opened


def record_equity(ledger: dict[str, Any], now_ms: float) -> float:
    equity = _equity(ledger)
    curve = ledger.setdefault("equity_curve", [])
    stamp = data.iso(now_ms)
    last = curve[-1] if curve else None
    if not last or last.get("t") != stamp:
        curve.append({"t": stamp, "equity": equity})
    else:
        last["equity"] = equity
    if len(curve) > EQUITY_POINTS_MAX:
        del curve[:-EQUITY_POINTS_MAX]
    return equity


# --------------------------------------------------------------------------- #
# read model
# --------------------------------------------------------------------------- #

def snapshot(ledger: dict[str, Any], now_ms: float) -> dict[str, Any]:
    """The compact, dashboard-safe view of the book."""
    starting = round(float(ledger.get("starting_cash") or 0), 2)
    cash = round(float(ledger.get("cash") or 0), 2)
    open_positions = ledger.get("positions") or []
    trades = ledger.get("trades") or []

    marked = []
    for position in open_positions:
        value = _position_value(position)
        cost = float(position.get("cost_basis") or 0)
        pnl = round(value - cost, 2)
        marked.append({
            "trade_id": position.get("trade_id"),
            "market_id": position.get("market_id"),
            "question": position.get("question"),
            "url": position.get("url"),
            "side": position.get("side"),
            "category": position.get("category"),
            "entry": position.get("entry"),
            "last_price": position.get("last_price"),
            "stop": position.get("stop"),
            "target": position.get("target"),
            "shares": position.get("shares"),
            "cost_basis": cost,
            "market_value": value,
            "unrealized_pnl": pnl,
            "unrealized_pct": round((pnl / cost) * 100, 2) if cost else 0.0,
            "risk_dollars": position.get("risk_dollars"),
            "opened_utc": position.get("opened_utc"),
            "time_limit_utc": position.get("time_limit_utc"),
            "last_mark_utc": position.get("last_mark_utc"),
        })

    equity = round(cash + sum(item["market_value"] for item in marked), 2)
    unrealized = round(sum(item["unrealized_pnl"] for item in marked), 2)
    realized = round(float(ledger.get("realized_pnl") or 0), 2)

    wins = [trade for trade in trades if float(trade.get("pnl") or 0) > 0]
    losses = [trade for trade in trades if float(trade.get("pnl") or 0) <= 0]
    gross_win = round(sum(float(t.get("pnl") or 0) for t in wins), 2)
    gross_loss = round(sum(float(t.get("pnl") or 0) for t in losses), 2)
    best = round(max((float(t.get("pnl") or 0) for t in trades), default=0), 2)
    worst = round(min((float(t.get("pnl") or 0) for t in trades), default=0), 2)

    curve = []
    peak = starting
    max_drawdown = 0.0
    for point in ledger.get("equity_curve") or []:
        value = round(float(point.get("equity") or starting), 2)
        peak = max(peak, value)
        drawdown = round((value / peak - 1) * 100, 2) if peak else 0.0
        max_drawdown = min(max_drawdown, drawdown)
        curve.append({"t": point.get("t"), "equity": value})

    working = []
    for order in ledger.get("orders") or []:
        working.append({
            "order_id": order.get("order_id"),
            "market_id": order.get("market_id"),
            "question": order.get("question"),
            "url": order.get("url"),
            "side": order.get("side"),
            "entry_type": order.get("entry_type"),
            "trigger": order.get("trigger"),
            "entry": order.get("entry"),
            "quote_at_approval": order.get("quote_at_approval"),
            "last_price": order.get("last_price", order.get("quote_at_approval")),
            "stop": order.get("stop"),
            "target": order.get("target"),
            "shares": order.get("shares"),
            "risk_dollars": order.get("risk_dollars"),
            "time_limit_utc": order.get("time_limit_utc"),
            "created_utc": order.get("created_utc"),
        })

    closed = []
    for trade in trades[-12:][::-1]:
        closed.append({
            "trade_id": trade.get("trade_id"),
            "market_id": trade.get("market_id"),
            "question": trade.get("question"),
            "side": trade.get("side"),
            "entry": trade.get("entry"),
            "exit": trade.get("exit"),
            "exit_reason": trade.get("exit_reason"),
            "shares": trade.get("shares"),
            "cost_basis": trade.get("cost_basis"),
            "pnl": trade.get("pnl"),
            "return_pct": trade.get("return_pct"),
            "closed_utc": trade.get("closed_utc"),
            "held_hours": trade.get("held_hours"),
        })

    return {
        "mode": "paper",
        "currency": "USD",
        "starting_cash": starting,
        "cash": cash,
        "equity": equity,
        "realized_pnl": realized,
        "unrealized_pnl": unrealized,
        "total_pnl": round(equity - starting, 2),
        "return_pct": round((equity / starting - 1) * 100, 2) if starting else 0.0,
        "open_count": len(marked),
        "working_count": len(working),
        "closed_count": len(trades),
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate": round(len(wins) / len(trades) * 100, 1) if trades else 0.0,
        "gross_win": gross_win,
        "gross_loss": gross_loss,
        "best_trade": best,
        "worst_trade": worst,
        "max_drawdown_pct": max_drawdown,
        "open_positions": marked,
        "working_orders": working,
        "closed_trades": closed,
        "equity_curve": curve[-120:],
        "updated_utc": data.iso(now_ms),
        "policy": ledger.get("policy", "simulated fills; no broker, wallet or order client"),
    }


def detail(ledger: dict[str, Any], now_ms: float) -> dict[str, Any]:
    """Full ledger plus the compact view, used for the published transparency file."""
    return {
        "snapshot": snapshot(ledger, now_ms),
        "starting_cash": ledger.get("starting_cash"),
        "cash": ledger.get("cash"),
        "realized_pnl": ledger.get("realized_pnl"),
        "open_positions": ledger.get("positions") or [],
        "working_orders": ledger.get("orders") or [],
        "closed_trades": (ledger.get("trades") or [])[-60:],
        "equity_curve": ledger.get("equity_curve") or [],
        "updated_utc": ledger.get("updated_utc"),
    }


def save_ledger(cfg: Config, ledger: dict[str, Any], now_ms: float) -> dict[str, str]:
    ledger["updated_utc"] = data.iso(now_ms)
    path = ledger_path(cfg)
    _write(path, json.dumps(ledger, indent=2) + "\n")
    files = {"ledger": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)}
    if cfg.public_copy:
        public = ROOT / "public" / "reports" / "ledger.json"
        _write(public, json.dumps(detail(ledger, now_ms), indent=2) + "\n")
        files["public"] = str(public.relative_to(ROOT))
    return files
