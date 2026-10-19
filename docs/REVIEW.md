# Review: the “Opus 6-Agent Trading System” guide

Source reviewed: [the Google Doc](https://docs.google.com/document/d/109vLyKr8RFYtZuB3RiQ5PJKu0fM_DPHTwCnSIBaBTdI/edit) (`OPUS 6-AGENT TRADING SYSTEM`, by @seb.ai), plus this repository at commit `cc871cf`.

## Short verdict

The document is a reasonable **research checklist**: it forces a market, a reason, a source, a chart, a plan, a risk check and one final decision to line up in that order. That alone is better than most “AI trading bot” content.

It is **not a bot**, and it is not close to one. It is a set of prompts for a chat model, with a build prompt for a local demo. It has no market discovery at scale, no data ingestion, no scheduling, no persistence, no benchmark, no fill model and no evaluation loop. Its numbers are self-reported and explicitly unverifiable. Followed literally, the workflow would stall constantly, because it treats missing data as a reason to stop the whole desk and treats language-model output as evidence.

This repository implements the useful part — the six-stage decision pipeline — as deterministic Python with a schema, hard risk limits, labelled fixture data, saved reports and tests. It deliberately contains **no order execution**.

## What the document actually specifies

1. Six roles in sequence: **Scout → News → Charts → Strategy → Risk → Boss**.
2. A shared JSON envelope with `status: complete | needs_data | rejected`.
3. Copy-paste prompts for each role, each told not to invent data.
4. A Claude Code build prompt: read prompts, run sequentially, validate JSON, stop on `needs_data`/`rejected`, Risk veto, Boss limited to three outcomes, timestamped reports, a local dashboard, hard-coded paper mode, tests.
5. A paper-trading workflow and a pre-set risk-rule list.
6. Warnings that the “$200 to $4,523 in 48 hours” result is self-reported and not reproduced.

That is a **specification for a decision log**, not a strategy. There is no statement of what edge is being harvested, why prices would be wrong, or how a market is selected from hundreds. “Unusual price, volume, volatility or activity” is not a signal definition; every liquid market is unusual at some point.

## The structural problems

### 1. Prompts are not enforcement

“Do not invent data” is a wish. A language model can still produce a plausible support level, a headline, or a volume figure. The document’s own troubleshooting section admits this (“The agent invents facts”) and answers it with a stronger prompt. The correct answer is a schema plus code that **cannot** produce a number not present in the input. This implementation has no model in the loop: every number is computed from supplied data, and missing inputs produce `needs_data`.

That trade-off is real: the desk cannot “read” an article body or weigh qualitative context. It reads titles, timestamps, sources and price series. Everything else is out of scope by design.

### 2. “Stop the pipeline if any agent returns needs_data” is brittle at 400+ markets

With hundreds of markets, gaps are normal: a closed book, a missing quote, a source with no date, a market resolving in an hour. If one market's missing headline halts the whole desk, the system almost never completes. The document's rule is right at the **stage** level and wrong at the **market** level.

Implementation: a stage that cannot produce a usable report halts the pipeline (and the Boss can only WAIT); individual markets without sources or history are dropped from the candidate list, with the reason recorded. No substitute evidence is created.

### 3. Scanning 400+ markets is a data problem, not a prompt

The document never says where the 400 markets come from, how they are filtered, or how “unusual” is normalised. Ranking by raw 24h volume produces a list dominated by a handful of sports events. A 20% move means something different on a 3¢ long-shot than on a 50¢ contract.

Implementation: pull the top ~500 active Polymarket markets by 24h volume (paged Gamma API), then score each market **within its own category** using robust z-scores (median/MAD) of |1h move|, |24h move| and log volume, plus spread, comment activity and time to resolution. The Scout's output is an attention list; it cannot recommend a trade.

### 4. News is a retrieval problem, and headlines are claims

The News prompt asks for “supplied articles, filings, announcements and source links”. The setup supplies none, and the build prompt says to use fixtures. A model asked to summarise articles it does not have will either refuse or invent. Headline sentiment is also a weak proxy: “Senate passes bill” is positive for one contract and negative for another, and many questions are inverted (“Will X fall below…”).

Implementation: Google News RSS via a same-origin relay, up to eight dated headlines per shortlisted market, with source, timestamp, age, duplicate detection and relevance scoring. Items that use speculative language are flagged. The tone field is keyword polarity and is **explicitly disabled** for team-vs-team markets and synthetic data; it can add a disagreement, never flip the trade side. No article body is read.

### 5. Technical analysis on a probability series is not the same as on a stock

“Support, resistance, volume” assumes a continuous, liquid, mean-reverting-ish price process. Prediction-market prices are bounded at 0 and 1, event-driven, and often jump on a single headline. CLOB price history also does not provide candle volume, so a volume-based chart rule cannot be implemented honestly from that feed.

Implementation: 24 hours of 15-minute closes, trend from a linear fit relative to average bar range, ATR, recent swing high/low, clustered pivots with two touches, range position and a structure break. Activity is reported as the share of bars that changed price. Every level is context for a rule, never a prediction. The screen shows conflicts and warnings rather than hiding them.

### 6. Risk is stated as principles, not arithmetic

The document's risk list is directionally right (paper only, no leverage, max exposure, max positions, freshness, liquidity, manual approval) but leaves out the arithmetic that decides survival:

- **Position size must come from the stop distance**, not from a fixed dollar amount. Risk per share × shares is the loss if the invalidation is hit.
- **Fees and spread must be charged before the R:R test.** A 1.5:1 gross setup can be below 1:1 net on a wide book.
- **Correlation is event-level.** Ten “Fed cuts” contracts are one position. Duplicate questions are worse.
- **A stale quote is not a price.** `updatedAt` on an illiquid market can be hours old.
- **The Boss must not be allowed to resize or relax a rule.** Its only jobs are to check completeness and return one of three statuses.

Implementation: every plan is checked against freshness, paper mode, sources, event risk, liquidity, spread, history length, chart conflicts, entry distance, gross and net R:R, reward-to-spread, share minimum, position slots, category/event/duplicate concentration, exposure and daily risk. Sizes are the minimum of the risk budget, remaining exposure and 1% of quoted liquidity. A failed check is a veto; Risk cannot be overridden by the Boss.

### 7. “Six agents” is a role-play decomposition, not six independent analysts

All six stages read the same three inputs. News tone, chart trend and the Scout score are correlated by construction. Calling them agents encourages a false sense of consensus. The document itself says disagreements should go to the Boss rather than be averaged — that is the right call — but a Boss that sees five correlated reports is not a committee.

Implementation: treat the pipeline as an ordered checklist with observable rules. The Boss checks completeness, count of risk-cleared plans, and unresolved disagreements. If any plan carries a conflict, it is held; if none are clean, the decision is WAIT. The UI calls them stages and shows the raw reports, because that is what they are.

### 8. The performance claim is not evidence

The carousel claim (“$200 to $4,523 in 48 hours”) is self-reported. The document says so. Two things are missing even for paper results:

- **A benchmark.** Without comparing against a trivial baseline (random selection, buy-and-hold, always-YES), a P&L number is noise.
- **A sample and a cost model.** A 48-hour run is a handful of trades. Fees, spread, latency and adverse selection dominate small samples. A demo mode with built-in lag would prove nothing either.

Implementation: no performance claim is made anywhere. Test mode is labelled `SYNTHETIC TEST DATA` on the page, in the banner and in every report. The journal records what the plan was **before** the outcome is known. There is no equity curve because there is no defensible basis for one yet.

## What this repository adds

| Document | Implementation |
|---|---|
| Six prompt files | `agents/*.md` contracts + six deterministic functions in `tools/desk/agents.py` |
| “Use only supplied data” | No model; all values computed from normalised inputs |
| Shared JSON envelope | `base_report()` + `validate_report()` / `validate_run()`; tests cover malformed and missing reports |
| Fixture data | `data/fixtures.json`, 520 seeded synthetic markets with 24h series and headlines, all labelled |
| Live data, optional | Gamma markets, CLOB price history and Google News RSS, fetched server-side and read-only |
| Timestamped reports | `reports/<run>.json` + `.md` + `index.json`, atomic writes, committed static snapshot |
| Dashboard | Reads saved reports; pipeline, per-stage evidence, raw JSON, Boss verdict, paper journal |
| Risk veto | `run_risk()`; every plan gets named checks and a verdict |
| Boss restricted | Three statuses only; cannot approve with a missing stage; cannot change limits |
| Paper workflow | Saved run reports, JSON download, manual paper journal with outcomes, CSV/JSON export |
| Tests | 33 tests covering config enforcement, schema, missing stages, staleness, missing sources, veto, concentration, sizing, determinism, persistence and absence of order code |

The desk also adds things the document does not specify: cost-aware net R:R, conditional limit entries (pullback / breakout retest), a maximum stop distance, a maximum distance between the planned entry and the quote, duplicate-question rejection, event/category concentration, and an explicit audit trail of every check.

## What is still not solved

- **No backtester.** The pipeline evaluates one snapshot at a time. It does not replay history or compute a fill model. A proper study would need historical quotes, not just mid prices, and would have to model queue position and adverse selection.
- **No resolution tracking.** Journal outcomes are entered by hand. The desk does not claim to know how a market resolved.
- **No scheduler.** Live mode is a manual button press. Running it every few minutes would require rate-limit handling, storage and alerting that are out of scope here.
- **No slippage calibration.** The cost buffer is a fixed percentage of notional plus half the spread. Real fills on thin books can be worse.
- **No qualitative news understanding.** Headlines only. A human still has to read the article before trusting a plan.
- **No live orders.** Intentionally. There is no wallet, key or signing code anywhere; the only POST route runs the pipeline, and `/api/orders` answers 405.
- **No legal review.** Prediction-market access is restricted in some jurisdictions. This project is educational and must not be used where it is not permitted.

## Minimum bar before risking money

1. Pre-register the rules and the risk limits; do not tune them after seeing results.
2. Collect **at least 300 paper trades** across different regimes, with the plan logged before the outcome.
3. Measure calibration (are 60% plans winning 60%?), net P&L after fees, maximum drawdown, and the distribution of maximum adverse excursion.
4. Compare against a naive benchmark on the same markets.
5. Track the **rejection rate** and the reasons. If Risk rejects nothing, the gate is decorative. If it rejects everything, the strategy is too brittle.
6. Test out-of-sample on a later period. A pipeline that only works on the data used to design it has no evidence.
7. Only then consider a small live allocation — with a kill switch, position caps and manual approval. Even then, the answer may be no.

## Bottom line

Use the document for its **sequence** and its safety posture. Do not use it as a trading system. As written it is a prompt scaffold: the prompts cannot source 400 markets, verify a headline, enforce a risk limit or prove an edge. This repo turns the scaffold into an auditable paper desk — schema-validated reports, deterministic checks, a real veto — and keeps the most important sentence in the document: *a successful first run means the workflow completed safely; it does not mean the strategy is profitable.*
