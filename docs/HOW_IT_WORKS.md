# How the desk works

The method behind the six reports. Everything here is implemented in `tools/desk/` and runs on the
Python standard library; PyYAML is used when present and a small subset reader is used otherwise.
There is no language model in the pipeline: each agent is a deterministic function, so the same
inputs and clock always produce the same reports.

## Shape of a run

```
data source ──► SCOUT ──► NEWS ──► CHARTS ──► STRATEGY ──► RISK ──► BOSS
                  │         │         │           │          │        │
              watchlist  sources    levels      one plan   veto     one of
              (attention) + ages     + trend     or WAIT    /size    3 statuses
```

If a **stage** cannot produce a usable report it returns `needs_data`. The chain stops, missing
stages are absent from the run, and the Boss can only `WAIT` (or `REJECT` when a stage is missing).
A single **market** with no quote, too little history or no source is dropped inside its stage with
the reason recorded; it does not halt the whole desk. That distinction matters at 400+ markets,
where gaps are normal.

## Data sources

**Live mode** (`--source live`) uses three public, read-only feeds:

- **Gamma `/markets`** — active, not closed, ordered by 24h volume, paged 100 at a time up to the scan
  cap (default 500). Normalised per market: outcomes, CLOB token ids, mid price from bid/ask,
  spread, liquidity, 24h volume, 1h/24h/1w changes, end date, fee schedule, order minimum. If the
  feed has no bid, ask or reported spread, the market is marked `has_quote: false` and Scout drops
  it. The desk never invents a book.
- **CLOB `/prices-history`** — 24h of 15-minute closes for the primary token. Falls back to `1w` at
  60-minute fidelity when the short window is empty. Empty history → the market is dropped from
  Charts, not filled with a synthetic line.
- **Google News RSS** — up to 8 headlines per market, queried from the event title and question.
  Titles, links, publishers and publish dates only; no article bodies.

**Fixture mode** (default) uses `data/fixtures.json`: 520 generated markets, a seeded mulberry32
generator, and relative timestamps (`hours_to_end`, `quote_age_min`) so the snapshot never goes
stale. Prices are walked backwards from the quoted price so the series ends where the quote is —
forward-anchored synthetic trends would flatten out. Every record is labelled synthetic, and the
dashboard banner says so.

## Scout — attention, not a signal

1. **Quality gate.** Reject if: not accepting orders, closed, no order book, missing token ids, no
   two-sided quote, liquidity below `min_liquidity`, spread above `max_spread`, spread above 20% of
   price, no resolution date, or resolving inside `min_minutes_to_resolution`.
2. **Category normalisation.** Group survivors by category (sports, politics, crypto, econ, culture,
   weather, other) and compute the median and MAD of `|1h move|`, `|24h move|` and `log1p(24h
   volume)` inside each group. A 20% move on a 3¢ long-shot is not comparable to 20% on a 50¢
   contract.
3. **Score (0–100).** Robust z-scores: 1h move up to 24 points, 24h move up to 20, volume up to 22;
   plus 6 for aligned 1h/24h direction, 4 for a tight spread, 3 for event comments.
4. **Floor and shortlist.** Anything under `activity_floor` (8) is counted as `low_signal`; the
   remainder is sorted and capped at `shortlist_size` (30).

The report records the universe size, exclusions by reason, category counts, and every excluded
market's reason. Scout never returns a direction.

## News — claims, not facts

For each watchlist market:

- Build a keyword query from the event title and question, minus stop words.
- Fetch headlines and record title, publisher, link, publish time and age.
- Flag: `stale` if older than `max_headline_age_hours` or undated; `speculative` when the title uses
  words like *may*, *reportedly*, *analysts expect*; `duplicate` for repeated normalised titles.
- Relevance is `direct` (≥2 query words), `partial` (1), `unclear` (0) — and `pooled` for synthetic
  headlines that are shared across a category.
- **Tone** is a crude keyword polarity (beat/pass/wins vs miss/reject/fails). It is reported, but
  **disabled for rules** on synthetic/pooled headlines and on team-vs-team markets where a
  "constructive" headline has no Yes/No polarity. It is never treated as a verified outcome.
- Event risk comes from the category and a fixed keyword list (FOMC, CPI, election, kickoff,
  deadline), or is `unknown`. Never inferred from price action.

A market with no fresh, dated source is flagged `NO_SOURCES` and cannot receive a plan while
`require_news` is true.

## Charts — describe, do not predict

- **Trend.** Linear fit of closes in probability points per hour, compared with the average bar
  range (`atr`). `up` if slope > 1.2 × atr, `down` if below −1.2 × atr, else `range`.
- **Momentum.** Change over the last hour, and a 3-hour slope for context.
- **Volatility.** ATR is the mean absolute bar-to-bar change; `atr_pct = atr / last`.
- **Support / resistance.** Swing pivots (2-bar lookaround), clustered to 0.5¢ buckets, kept only
  with ≥2 touches. This is context for a rule, not proof of a level.
- **Structure break.** Last close beyond the prior 1h range by 0.5 × atr. Deliberately measured
  against the *prior* range, not the next resistance above price, so the plan is not chasing.
- **Conflicts.** Trend vs last-hour momentum, range vs structure break, chart trend vs direct
  headline tone, high event risk. Conflicts are surfaced and later block approval.
- **Both outcomes.** The inverse series (`1 − p`) is analysed with the same code, so no outcome gets
  a privileged view. Volume is unavailable from the price-history endpoint, so activity is reported
  as the share of bars that changed; no candle volume is invented.

## Strategy — one plan, or WAIT

Pick a side only when trend and structure agree: primary up / secondary down, or a confirmed upward
structure break on either side. If neither, WAIT with the reason.

Entry rules. A breakout plan enters at the quote and fills in the paper book immediately. Pullbacks,
retests and reversals are conditional: the approval becomes a **working order** (limit below the
quote, or stop above it) that fills only when the market trades to the level, and expires at the
plan's time limit. No fill is ever simulated at a price the market did not reach.

| Setup | Entry | Invalidation | Notes |
|---|---|---|---|
| Pullback | nearest support + 0.25 ATR | support − 0.25 ATR, else recent low − 0.25 ATR, else entry − 2 ATR | must sit under the quote and within `max_pullback_distance` (0.05) |
| Breakout | current quote (ask) | last swing low − 0.25 ATR, else entry − 2 ATR | only when the quote is above the prior 1h high and not extended |
| Breakout retest | broken level + 0.25 ATR | broken level − 0.75 ATR | used when the uptrend is already extended |
| Reversal | reclaim level + 0.25 ATR | same stop logic as a pullback | requires a flat/negative trend plus a reclaim |

Target = the greater of **entry + 4 ATR** and the next strong resistance above entry. Time limit =
`min(now + 6h, market end − 10min)`.

Rejections (each becomes a WAIT with the exact reason recorded):

- no fresh source, high event risk, or low-relevance headline set; medium event risk is
  priced by Risk, which halves the position instead of blocking it;
- average bar range > 12% of price (too noisy for a fixed stop);
- stop distance > `max_stop_distance` (0.12) or entry not above invalidation;
- entry > `max_entry_distance` (0.12) away from the quote;
- pullback/retest entry not below the quote, or a pullback > 0.05 under it;
- a working order whose level is beyond the max entry distance;
- target not above the quote + 0.005 (the move may already be priced);
- gross reward:risk < `min_net_rr` (1.5);
- extended price with no structure break (the retest is shown, but not filled).

Confidence is a 0–100 sum of six observable conditions (trend, structure, noise, volume z-score,
fresh sources, tone agreement). It is displayed, not used as a gate.

## Risk — the veto

Common checks run first: every upstream report present with a parseable timestamp, oldest report
inside `watchlist_freshness_minutes` (30), and mode/`allow_live_orders` as configured.

Per plan (any failure = `REJECTED`):

| Group | Check |
|---|---|
| Plan | `plan_ready` |
| Freshness | `fresh_quote` (≤60 min), `fresh_news`, `news_required` |
| Market | `event_risk`, `liquidity`, `spread`, `history` |
| Structure | `chart_conflicts`, `unresolved_disagreements` |
| Economics | `rr_after_costs`, `stop_vs_spread`, `entry_within_band`, `net_reward_to_spread`, `net_rr` |
| Sizing | `size`, `order_minimum`, `position_cap` |
| Concentration | `category_concentration`, `event_concentration`, `duplicate_question` |

Cost model: `cost = spread / 2 + price × 2%` per share. Net risk is `stop distance + cost`; net
reward is `reward − cost`; `net_rr` must clear 1.5. A stop inside the spread is noise and is
rejected outright.

Sizing: `shares = floor(risk_budget / net_risk)`, capped by remaining exposure
(`bankroll × 25% − open notional`), remaining daily risk (`6% − committed`), 1% of quoted liquidity,
and the exchange's minimum order size. Medium event risk halves the risk budget and labels the
result `REDUCED` (not `PASSED`). A plan that rounds to zero shares is rejected.

The risk report records every check with `pass` plus a factual detail string, so a rejection can be
read without guessing.

## Boss — one status

| Decision | Condition |
|---|---|
| `APPROVE_FOR_PAPER_TEST` | all five upstream reports present and complete; Risk cleared at least one plan; that plan has no unresolved disagreement |
| `WAIT` | the pipeline halted; strategy produced only WAITs; or every cleared plan carries a conflict |
| `REJECT` | a report is missing/incomplete, or Risk rejected every plan |

The Boss never averages disagreements, never resizes, never relaxes a limit and never orders. It
records integrity checks, the disagreement list, counts and the `final_word`: paper only, no orders,
human approval required.

## Reports and validation

Each stage emits the envelope `{agent, timestamp_utc, status, summary, evidence[], risks[],
next_step, meta}`. `validate_report` rejects a missing agent, unparseable timestamp, unknown status,
non-string summary, non-array evidence/risks, or missing next_step. `validate_run` additionally
requires all six reports, a valid Boss decision, and `mode: paper` with `allow_live_orders: false`.
A validation failure raises `PipelineError` and **does not save**.

Saved runs: `reports/<YYYYMMDDTHHMMSSZ>-<source>.json`, a matching `.md`, `latest.json` and
`index.json` (30 runs). Writes are atomic (temp file, fsync, replace). The newest five runs are also
copied to `public/reports/` (without local file paths) so the static dashboard can browse history;
older published snapshots are pruned automatically.

## Determinism and testing

With `--source fixture`, a fixed clock and the same seed, the output is byte-comparable (timestamps
aside). `tests/test_desk.py` covers config enforcement, data labelling, normalisation without a
quote, determinism, report persistence, schema failures, missing stages, halted stages, Boss
restrictions, stale inputs, missing sources, spread veto, event concentration, duplicate questions,
sizing limits, the HTTP surface, and the absence of wallet/order code.

Run them with:

```bash
python3 -m unittest discover -s tests -v
```

## Known limits

- The desk sees one quote per market, not a book. Depth beyond 1% of quoted liquidity is unknown.
- Headlines are titles, not articles; tone is a keyword proxy and is disabled where it is meaningless.
- Levels are statistical clusters, not psychological levels; they can be noise.
- The fixture board is generated to be well-behaved. Its approval rate is meaningless as a forecast.
- There is no fill model, no slippage model and no evaluation of whether the plans would have won.
  That is deliberate: the journal records outcomes by hand, after the fact.
- Six stages are not six independent opinions. They share inputs; treat the pipeline as a checklist
  with a veto, not as an ensemble.
