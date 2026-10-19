# Opus Agent Desk

A working implementation of the six-agent setup described in the
[“Opus 6-Agent Trading System”](https://docs.google.com/document/d/109vLyKr8RFYtZuB3RiQ5PJKu0fM_DPHTwCnSIBaBTdI/edit)
guide — turned from a prompt outline into a runnable, testable pipeline.

```text
SCOUT ──► NEWS ──► CHARTS ──► STRATEGY ──► RISK ──► BOSS
scan 400+  dated    trend &    one plan      veto /    approve · wait
markets   sources  levels     or WAIT       sizing    · reject
```

Each stage is **deterministic Python**, not a language model. Every stage writes a timestamped
report in the shared envelope from the doc; the Boss reads all five and returns exactly one of
`APPROVE_FOR_PAPER_TEST`, `WAIT` or `REJECT`.

**Paper only.** There is no wallet, key, signature, brokerage link or order endpoint anywhere in
this repository. `config.yaml` is hard-wired to `mode: paper` and `allow_live_orders: false`, and the
runner refuses to start otherwise. A human is required before anything else happens.

---

## Quick start

```bash
python3 main.py                                # run the desk once on the fixture board
python3 main.py --serve                        # dashboard at http://localhost:8765
```

No dependencies and no build step: the runner is standard-library Python, and `config.yaml` is read
by a small YAML-subset loader when PyYAML is not installed. If you prefer the real parser:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

Expected first run: **520 markets scanned → 10 on the watchlist → 4 plans → risk clears 1 →
`APPROVE_FOR_PAPER_TEST`**, saved to `reports/`.

```bash
python3 main.py --serve --open        # serve and open a browser
python3 main.py --source live         # read-only public data
python3 main.py --json                # print the full run record
python3 main.py --build-fixtures      # regenerate data/fixtures.json
python3 -m unittest discover -s tests -v
```

On many distributions `pip install` is blocked by PEP 668; that is why PyYAML is optional rather
than required.

## What each agent actually does

| # | Agent | Job | Never does |
|---|-------|-----|-----------|
| 1 | **Scout** | Ranks unusual movement and volume across the whole universe, normalised inside each category (robust z-scores vs category medians). Excludes closed/illiquid/wide-spread markets. | Recommend a side or invent a quote |
| 2 | **News** | Attaches dated, attributable headlines; flags stale, duplicate, speculative and low-relevance items; estimates event risk. | Summarise an article body it was not given, or invent a source |
| 3 | **Charts** | 24h of 15-minute closes: trend, momentum, ATR, support/resistance (clustered swing pivots), structure breaks, extension warnings and **conflicts**. Analyses the inverse series too, so both outcomes are treated equally. | Predict a guaranteed outcome or fabricate candle volume |
| 4 | **Strategy** | Writes at most one conditional plan per market: entry type (pullback / breakout / breakout-retest / reversal), entry zone, trigger, invalidation, target, time limit, gross R:R, confidence. | Force a setup, size a position, or lower a limit |
| 5 | **Risk** | 23 named checks per plan: pipeline freshness, paper mode, plan readiness, sources, liquidity, spread, stop vs spread, reward vs spread, cost-adjusted R:R, share count, exposure, position caps, category/event concentration, duplicate questions. **Any failure is a veto.** | Relax a rule to make a plan pass, or be overruled by Boss |
| 6 | **Boss** | Confirms all five reports exist, are complete and timestamped, then returns one final status. Disagreements are held, never averaged. | Approve on a partial pipeline, resize, or place an order |

## The report envelope

Every stage emits the same shape, validated on every run before anything is saved:

```json
{
  "agent": "scout",
  "timestamp_utc": "2026-10-19T04:02:20Z",
  "status": "complete | needs_data | rejected",
  "summary": "one paragraph, plain language",
  "evidence": [],
  "risks": [],
  "next_step": "what the next stage should do",
  "meta": {}
}
```

* `needs_data` means the stage could not work with the inputs it had. It halts the chain; Boss can
  then only return `WAIT` (or `REJECT` if a stage is missing).
* A stage never fabricates a value to avoid `needs_data`. If a market has no quote it is excluded;
  if a series is too short it is reported as such.
* The Boss decision lives at `reports/<run>/boss/meta/decision` and is restricted to the three
  allowed statuses by the schema validator.

## Outputs

Each run writes three files, atomically:

```text
reports/20261019T040220Z-fixture.json   full run record (all six reports + config + contract hashes)
reports/20261019T040220Z-fixture.md     human-readable Markdown summary
reports/index.json                      newest 30 runs (id, decision, counts)
reports/latest.json                     pointer copy of the newest run
public/reports/latest.json              committed snapshot for static hosting
```

The dashboard reads `latest.json` (or `/api/latest` when the Python server is running) and renders
the six reports: the Scout table, News sources, Chart sparklines, Strategy plans and WAIT reasons,
the Risk checks and sizes, and the Boss decision with integrity checks. It also has a paper journal
that you update by hand after a result is known.

## Data sources

* **fixture** (default) — `data/fixtures.json`, 520 generated markets, clearly labelled
  `SYNTHETIC TEST DATA`. Timestamps are relative offsets so the snapshot never expires. The board is
  generated by a seeded mulberry32 PRNG and is not a price forecast.
* **test** — the same generator, run in memory with a different seed.
* **live** — public, read-only Polymarket Gamma `/markets` (paged, 100 at a time), CLOB
  `/prices-history`, and Google News RSS. No key required, no order path.

The fixture is intentionally labelled everywhere it appears: the report metadata, the dashboard
banner, the Markdown summary and every headline record carry the synthetic marker.

## Safety model

* `mode: paper`; `allow_live_orders: false` — enforced in `load_config`, not just documented.
* No credential handling: the repo contains no signing, wallet, key or order code (a test asserts
  this).
* GET-only API plus one mutating endpoint, `POST /api/run`, which merely runs the same pipeline as
  the CLI. `/api/orders` returns 405.
* Tests cover: malformed reports, missing timestamps, missing stages, stale inputs, missing sources,
  risk vetoes (spread, freshness, concentration, duplicate question), Boss restrictions, sizing,
  determinism, saved-report integrity, and the HTTP surface.

## Repository map

```text
main.py                  CLI: run once, serve the dashboard, rebuild fixtures
config.yaml              all thresholds and the two safety switches
agents/*.md              the six role contracts the runner cites (and hashes per run)
data/fixtures.json       labelled synthetic market board
tools/desk/config.py     config loading + paper-only enforcement
tools/desk/data.py       normalisation, fixtures, seeded generator, read-only live feeds
tools/desk/agents.py     the six agents
tools/desk/pipeline.py   runner, schema validation, persistence, Markdown summary
tools/desk/server.py     static dashboard + read-only JSON API
public/                  dashboard (HTML/CSS/JS), no build step
reports/                 local run output (git-ignored)
public/reports/          committed newest snapshot for static hosting
tests/test_desk.py       32 tests
docs/HOW_IT_WORKS.md     method, formulas and limits
docs/REVIEW.md           what the guide gets right and where it breaks
```

## Limits worth knowing

This is a **research workflow**, not a trading system and not financial advice. It does not prove an
edge, it cannot see order books beyond the supplied quote, it reads headlines rather than articles,
and the fixture board is friendlier than any real market. `WAIT` and `REJECT` are expected outcomes —
the desk rejects most candidate plans by design. Start with
[`docs/REVIEW.md`](docs/REVIEW.md) for the failure modes before trusting a green run.
