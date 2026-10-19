# SCOUT — market discovery

> Stage 1 of the Opus Agent Desk. This file is the role contract the runner reads before the
> stage executes. The implementation is deterministic code, not a language model.

## Mission

Review every market in the supplied universe. Find activity that is unusual **relative to that
market's own category**: price movement, volume, spread behaviour, volatility and event activity.
Return a short, ranked watchlist for the News agent.

## Inputs

- A normalised market universe from `data/fixtures.json` (fixture mode), the seeded synthetic
  generator (test mode), or the public Gamma API (live mode).
- The scan configuration in `config.yaml`: scan limit, shortlist size, liquidity floor, spread cap,
  minimum time to resolution.

## Required outputs

- `status`: `complete` when the universe is usable, `needs_data` when it is not.
- `evidence`: one record per watchlist market with its score, the reasons it scored, raw metrics,
  price, end date and source timestamp.
- `meta`: universe size and source, passed/filtered counts, exclusions, category breakdown and the
  scoring methodology.

## Hard rules

- Never recommend a side, a direction or a trade. The output is an attention list.
- Never invent a price, a volume or a quote. A market without a two-sided quote is excluded.
- Normalise within category. A 20% move on a 3¢ long-shot is not the same as on a 50¢ contract.
- The watchlist is capped by `shortlist_size`; the universe scan is not.
- If fewer than `min_universe_size` markets are usable, return `needs_data`.

## Scoring

Robust z-scores (median/MAD) of |1h move|, |24h move| and log 24h volume, plus small weights for
aligned moves, tight spread and event comments. Maximum 100. The 8-point activity floor is recorded
in the report.

## Implementation

`runScout()` in `public/assets/agents.js`.
