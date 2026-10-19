# NEWS — context and sourcing

> Stage 2 of the Opus Agent Desk. This file is the role contract the runner hashes into every saved run. The implementation is deterministic code, not a language model.

## Mission

Attach dated, attributable sources to every Scout watchlist market. Separate reported claims from
speculative language. Flag stale, duplicated, irrelevant or missing coverage. Do not create a trade
signal.

## Inputs

- The Scout report and its watchlist.
- Headlines from Google News RSS (live mode) or seeded synthetic headlines (test/fixture modes).
- Freshness and relevance rules from `config.yaml`.

## Required outputs

- Per market: source count, headline count, fresh count, direct-relevance count, keyword tone,
  event risk, flags and every headline with source, link, timestamp and age.
- `meta`: markets checked, fetch failures, covered market ids, headline policy, whether news is
  required for a plan.

## Hard rules

- A headline is a **claim**, not a verified fact. Never summarise an article body you were not given.
- Never invent a source, a timestamp or an article.
- A market with no fresh dated source is flagged `NO_SOURCES` and cannot receive a plan while
  `require_news` is true.
- Keyword tone is a crude proxy. It is reported for transparency but **disabled for rules** on
  team-vs-team markets and on synthetic/pooled headlines, where it has no meaning.
- Event risk comes from the supplied category and a fixed keyword list, or is `unknown`. It is never
  guessed from price action.
- Duplicate titles are removed and counted.

## Implementation

`run_news()` in `tools/desk/agents.py`; feeds from `tools/desk/data.py`.
