# STRATEGY — plan builder

> Stage 4 of the Opus Agent Desk. This file is the role contract the runner hashes into every saved run. The implementation is deterministic code, not a language model.

## Mission

Turn the Scout, News and Charts reports into at most **one** hypothetical paper-trade plan per
market, with a conditional entry, invalidation, target and time limit. If the evidence conflicts or
the rules do not line up, return `WAIT`. Never force a setup.

## Inputs

- Scout watchlist and score.
- News sources, tone flags and event risk.
- Chart trend, levels, structure break and conflicts.
- Limits from `config.yaml`: minimum R:R, maximum stop distance, maximum entry distance, maximum
  pullback distance, news requirement.

## Required outputs

- For a plan: side, setup type (`pullback`, `breakout`, `breakout_retest`, `reversal`), entry, entry
  zone, entry trigger, invalidation, target, time limit, gross R:R, confidence, evidence used and
  any unresolved disagreements.
- For a WAIT: the exact reasons.

## Hard rules

- No plan without a fresh dated source when `require_news` is true.
- No plan when event risk is high.
- No plan when the stop is wider than `max_stop_distance`, the entry is farther than
  `max_entry_distance` from the quote, or a pullback entry is farther than
  `max_pullback_distance` below the quote.
- The target must be above the current quote; the move must not already be priced.
- A pullback/retest entry must sit below the quote; the paper book rests it as a working limit and fills only when the price reaches it. A reversal rests a stop order above the quote.
- Gross R:R must clear `min_net_rr` before the plan can proceed.
- Never size a position, never place an order, never lower a limit to make a plan fit.

## Implementation

`run_strategy()` in `tools/desk/agents.py`.
