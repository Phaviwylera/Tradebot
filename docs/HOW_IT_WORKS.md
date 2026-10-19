# How the desk works

This is the method behind the six reports. Everything here is implemented in
`public/assets/agents.js` and `public/assets/data.js`. There is no language model in the pipeline: each
agent is a deterministic function, so the same inputs and clock always produce the same reports.

## The shape of a run

```
data source ──► SCOUT ──► NEWS ──► CHARTS ──► STRATEGY ──► RISK ──► BOSS
                 │          │         │           │          │        │
              watchlist   sources    levels      one plan   veto     one of
              (attention) + ages     + trend     or WAIT    /size    3 statuses
```

A stage that cannot produce a usable report returns `needs_data`. The pipeline stops there, the Boss
receives only the completed stages, and the decision is WAIT or REJECT. A single market with a missing
headline or short history is dropped **inside** the stage with a recorded reason; it does not halt the
whole desk.

## Data sources

**Live mode** uses three read-only public feeds:

- **Gamma `/markets`** — active, not closed, ordered by 24h volume, paged 100 at a time up to the scan
  cap (default 500). Each market is normalised: outcomes, CLOB token ids, mid price, bid/ask, spread,
  liquidity, 24h volume, 1h/24h/1w price changes, end date, fee schedule, order minimum.
  If a market has no bid, ask or reported spread, `hasQuote` is false and Scout excludes it. The desk
  does not invent a book.
- **CLOB `/prices-history`** — 24 hours of 15-minute closes for the primary outcome token. If that
  fails, one retry on a 1-week/60-minute window. If both fail, the Charts agent records `needs_data`
  for that market.
- **Google News RSS** — up to eight headlines for a query built from the event title and question,
  with source, link and publication time. Only the title, source and date are used.

**Test mode** generates 520 markets in the browser from a seeded PRNG (mulberry32), plus a 24-hour
15-minute series per market and synthetic headlines. It is deterministic for a given seed and clock.
The series is generated **backwards from the quoted price**, so the last point always equals the
market quote and the intended regime shape is preserved. Every record is marked `synthetic: true` and
the page labels it. Test-mode approval rates are not evidence of anything.

## 1. Scout — attention, not advice

Universe filters: accepting orders, open, order book enabled, both tokens present, a two-sided quote,
liquidity ≥ floor, spread within limit, not resolving within the minimum window.

For every market that passes, Scout computes **within-category** statistics:

- `z_move_1h`, `z_move_24h` — robust z-scores of the absolute moves. The spread measure is
  `1.4826 × median absolute deviation`, not the standard deviation, so a single outlier does not
  flatten the whole category.
- `z_volume` — robust z-score of `log(1 + volume24h)`.
- `volume_ratio` — volume divided by the category median.
- Qualities: tight spread, aligned 1h/24h moves, comment count.

The score is a capped sum (0–100), dominated by 1h and 24h move z-scores and volume z-score, with
smaller weights for aligned moves, tight spread and event comments. Markets below 8 points are
discarded. The top `shortlistSize` (default 10) become the watchlist.

Scout reports the universe size, how many passed filters, how many failed quality, the category
breakdown and its methodology. It never names a side.

## 2. News — dated claims, with the gaps left visible

For each watchlist market, News builds a keyword query (stop words removed), fetches headlines and
records for each item:

- source, URL, publication time, age in hours
- `stale` if older than the maximum headline age (24h by default)
- `duplicate` if a normalised title was already seen for that market
- `relevance`: direct if at least two query tokens appear in the title, partial if one, otherwise unclear
- `speculative`: true when the title uses words such as *may*, *could*, *reportedly*, *analysts expect*
- keyword tone (constructive / cautious / neutral)

A market is **covered** only if it has at least one fresh, usable headline. Tone is **not** used for
team-vs-team markets or synthetic data; for those it is `not_applicable`. Keyword polarity is a crude
proxy and cannot understand an inverted question, so it may only create a disagreement for the Boss —
it can never flip a side. Headlines are claims; the desk does not verify them and does not read article
bodies.

Event risk is not guessed from nowhere: it is medium for macro/politics categories, medium when the
headline text names a scheduled event (FOMC, CPI, vote, hearing, earnings, kickoff), and otherwise
`unknown`. High risk can only come from a supplied hint (test data) or a headline; it blocks a plan.

## 3. Charts — describe, do not predict

Input: 24h of 15-minute closes for one outcome. The same function is run on the **inverse** series, so
both outcomes are analysed symmetrically.

For each series:

- **Trend**: a least-squares fit of price against hours. The slope is compared with the average
  absolute bar change (ATR). `up` if the hourly slope exceeds 1.2× ATR and is positive; `down` if it is
  below −1.2× ATR; otherwise `range`.
- **Momentum**: change over the last four bars (1 hour).
- **ATR / bar range**: mean absolute difference between consecutive closes, absolute and as a
  percentage of price. This is a volatility proxy, not traded volume.
- **Support / resistance**: swing pivots (a bar higher or lower than two neighbours each side),
  clustered at 0.5-cent buckets, with at least two touches. The two nearest levels on each side are
  reported. Recent 8-bar high/low is also reported.
- **Structure break**: current price more than 0.5× ATR outside the prior 1-hour range.
- **Range position**: where the last price sits between the window min and max.
- **Extension**: last price more than 1.5× ATR above its 8-bar mean while at the top 4% of the range.
- **Activity**: share of bars whose close changed.
- **Conflicts**: trend and last-hour momentum pointing opposite ways, or a structure break inside a
  range. **Warnings** cover extension, very noisy bars and short windows.

Charts adds conflicts from news: high event risk, or two or more direct headlines whose keyword tone
opposes the trend. Conflicts block a plan at Risk; warnings do not.

## 4. Strategy — one setup or nothing

For each chart-reviewed market, Strategy picks a **view** only if the primary and inverse trends agree
on direction, or a structure break exists. Otherwise it returns WAIT.

The entry is conditional, based on the setup type:

| Setup | Entry rule | Invalidation |
|---|---|---|
| Pullback (trend up, not extended) | `support + 0.25 ATR` | nearest support / recent low, capped at 2 ATR |
| Breakout (structure break) | current ask, above the prior 1-hour high | same stop logic |
| Breakout retest (extended break) | `broken level + 0.25 ATR` | `broken level − 0.75 ATR` |
| Reversal (range reclaim) | `range high + 0.25 ATR` | same stop logic |

Stop candidates are filtered to those at least `max(0.5 ATR, 0.006)` below entry; the highest surviving
candidate is used, so the stop sits at the nearest structural protection rather than a distant pivot.
Targets use the next resistance if it is above entry, otherwise `entry + max(4 ATR, 0.05)`. Everything
is clamped inside `(0.005, 0.985)`.

The plan is rejected with WAIT when:

- there is no fresh source and news is required,
- event risk is high,
- the headline set does not match the question,
- the stop is wider than `maxStopDistance` (0.12),
- the entry is more than `maxEntryDistance` (0.12) from the current quote,
- a pullback entry is more than `maxPullbackDistance` (0.05) below the quote,
- a conditional pullback or retest entry is not actually below the quote,
- the target is not above the current quote (the move has already been priced),
- the stop is not below entry,
- gross reward:risk is below `minNetRR` (1.5),
- the price is stretched in a non-breakout setup.

Confidence is a transparent sum of trend, structure, volatility, volume z-score, source count and
tone alignment. It is shown, but it is not used to override a failed rule.

## 5. Risk — the gate

Risk first repeats common checks on every plan: all upstream reports exist with timestamps, the oldest
report is within the freshness window (30 minutes), and `mode=paper` with `allowLiveOrders=false`.
Then, per plan:

- quote freshness (from the source timestamp, limit 60 minutes)
- at least one fresh dated source; news required
- event risk not high
- liquidity ≥ floor, spread ≤ limit
- history has at least 12 bars
- no blocking chart conflicts
- gross R:R ≥ floor
- planned entry within the entry band of the quote
- **net** R:R after costs ≥ floor
- reward ≥ 3× spread
- **stop distance ≥ spread** (a stop inside the spread is noise)
- size ≥ 1 share and ≥ exchange order minimum
- position slots, category cap, event cap, duplicate-question check

**Cost model.** Cost per share = `spread / 2 + price × costBufferPct / 100` (2% of notional by default,
covering fees and slippage). Net risk = stop distance + cost. Net reward = target distance − cost.
Net R:R must clear the floor.

**Sizing.** `shares = floor(risk_budget / net_risk_per_share)` where the risk budget is
`bankroll × maxPositionRiskPct / 100`, halved for medium event risk, capped by the remaining daily risk
budget. The result is then capped by the remaining exposure allowance and by 1% of quoted liquidity.
Notional is `shares × entry`. If any cap rounds the size below one share or the exchange minimum, the
plan is rejected.

A plan that fails **any** check is `REJECTED`. A passed plan with medium event risk is `REDUCED`.
Risk never relaxes a limit to let a plan through, and its failed-check names are shown in the UI.

## 6. Boss — one decision, no averaging

The Boss verifies:

- all five upstream reports exist,
- none is `needs_data` or `rejected`,
- every report carries a valid timestamp,
- paper mode and the live-order lock are on,
- Risk actually reviewed something and cleared at least one plan.

Decision tree:

- missing report → **REJECT**
- pipeline halted at any stage → **WAIT**
- no plan cleared Risk →
  - Risk rejected every plan → **REJECT**
  - Strategy returned WAIT on everything → **WAIT**
- plans cleared Risk but every one carries an unresolved disagreement → **WAIT**
- at least one clean, cleared plan → **APPROVE_FOR_PAPER_TEST**

`meta.approved` contains only clean plans, with entry, invalidation, target, time limit, shares,
notional, risk dollars and net R:R. The Boss cannot resize a plan, relax a check, or place an order.

## The report schema

Every stage returns:

```json
{
  "agent": "risk",
  "label": "RISK",
  "timestamp_utc": "2026-10-19T03:30:00.000Z",
  "status": "complete",
  "summary": "2 plan(s) cleared the risk gate, 1 rejected, 0 never reached it.",
  "evidence": [],
  "risks": [],
  "next_step": "Boss agent: confirm every stage, then approve, wait or reject.",
  "meta": {}
}
```

`validateReport()` enforces the agent name, timestamp, status, summary, evidence array, risks array,
next step, and — for the Boss — one of the three allowed decisions. The dashboard validates every stage
after a run and refuses to display a report that fails.

## Test-mode generator

- 520 markets: sports 175, politics 115, crypto 95, econ 65, culture 40, weather 20, other 10.
- Per market: price, 1h/24h changes, spread, liquidity, volume, end date, regime
  (`range`, `up`, `down`, `breakout`), headline count and event-risk hint.
- Every 22nd market is “hot”: wider price swings, tighter spreads, more liquidity and volume.
- The price path is a 96-point backward random walk with regime drift and noise, ending at the quote.
- Headlines are drawn from a small category pool and marked synthetic; keyword tone is not used for rules.

Seeds are selectable with “New day”. Different seeds produce different boards and therefore different
Boss decisions. This is useful for exercising the workflow, not for evaluating a strategy.

## Known limits

- No backtester, fill model, scheduler, resolution feed, database, authentication or alerting.
- Support/resistance and trend rules are weak evidence on event-driven probability markets.
- Keyword tone is crude and disabled where it would be misleading; no article is read.
- The cost buffer is a fixed assumption, not a calibrated slippage model.
- Journal outcomes are manual. The desk does not know how a market resolved.
- Synthetic data has designed trends; its approval rate is meaningless.
- Paper results do not prove live profitability. Fees, latency, adverse selection and oracle risk remain.

## Extending it

- Add a category-specific model behind the same envelope and let Risk consume its output.
- Add a historical replay harness with real quotes before changing any threshold.
- Add resolution tracking to close journal entries automatically, then compute calibration and net P&L.
- Add a benchmark comparison (random side, always-YES, buy-and-hold) before drawing conclusions.
- Keep the invariants: paper mode, no order path, Risk veto, Boss restricted to three statuses, no
  invented data.
