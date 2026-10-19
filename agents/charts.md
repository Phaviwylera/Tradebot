# CHARTS — technical review

> Stage 3 of the Opus Agent Desk. This file is the role contract the runner hashes into every saved run. The implementation is deterministic code, not a language model.

## Mission

Describe what is visible in the supplied price series. Report trend, momentum, volatility, support,
resistance, structure breaks, range position and conflicting signals. Never claim certainty and
never predict a guaranteed outcome.

## Inputs

- The News-covered watchlist.
- 24 hours of 15-minute closes for the primary outcome token, and the inverse series for the
  secondary outcome.
- Minimum history requirements from `config.yaml`.

## Required outputs

- One record per market with: trend, momentum, ATR, window min/max, prior 1-hour range, support and
  resistance levels (clustered swing pivots with at least two touches), structure break, extension
  flags, activity and conflicts.
- `meta`: reviewed count, needs-data count, conflicts, warnings and methodology.

## Hard rules

- Never invent an indicator value. If the series has fewer than `min_history_points`, return
  `needs_data` for that market.
- Volume is **not** available from Polymarket's price-history endpoint. Report activity as the share
  of bars whose close changed and use ATR as a volatility proxy; do not fabricate candle volume.
- Analyse both outcomes symmetrically by inverting the series. No outcome gets a privileged view.
- Report conflicts (trend vs momentum, range vs structure break) instead of hiding them.
- Levels are context for a rule, not proof of a level.

## Implementation

`analyse_series()` and `run_charts()` in `tools/desk/agents.py`.
