# Opus Agent Desk

A six-stage **paper-trading research desk** for Polymarket, built from the setup described in the
“Opus 6-Agent Trading System” guide.

The desk scans up to 500 active markets, finds genuinely unusual moves, attaches dated headlines,
reads price structure, writes one rule-based plan per candidate, and lets a risk gate veto anything
that does not clear its limits. The Boss returns exactly one of:

`APPROVE_FOR_PAPER_TEST` · `WAIT` · `REJECT`

There is **no wallet, no private key, no signing code and no order endpoint**. It cannot place a trade.
Read the full setup review in [`docs/REVIEW.md`](docs/REVIEW.md) and the method notes in
[`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md).

---

## Run it locally

```bash
python3 tools/local-server.py
# open http://localhost:8765
```

The page opens in **Test data** mode and runs immediately on a deterministic synthetic board
(“synthetic day 3”). Everything in that mode — questions, prices, headlines — is generated in the
browser and labelled as such. No network is required for test mode.

For the Python server, use Python 3.9+ (the app itself is plain HTML/CSS/JS; no build step).

### Live mode

Click **Live**. The server proxies three read-only upstreams:

| Path | Upstream |
|---|---|
| `/gamma/*` | `https://gamma-api.polymarket.com/*` — markets |
| `/clob/*` | `https://clob.polymarket.com/*` — price history |
| `/news?q=` | `https://news.google.com/rss/search?q=` — dated headlines |

If your network cannot reach Polymarket, Live will fail with a relay error. Test mode still works.
Live mode is read-only; the proxy is `GET`-only and the server answers `POST` with `405`.

### Tests

```bash
npm test        # node --test tests/*.test.mjs  (19 tests, no dependencies)
```

The tests cover the shared report schema, malformed reports, missing timestamps, stale inputs,
missing sources, risk veto, Boss restrictions, position sizing, event/duplicate concentration,
determinism, and the absence of order/wallet code in the browser bundle.

---

## Deploy on Vercel

1. Import this repository in Vercel (Add New → Project).
2. Leave the defaults. `vercel.json` publishes `public/` and adds the `/gamma`, `/clob` and `/news`
   rewrites.
3. Deploy.

No environment variables are required. Do not add secrets: there is nothing here that needs one.

---

## The six stages

| # | Stage | What it does | What it must not do |
|---|---|---|---|
| 1 | **Scout** | Pulls up to 500 active markets, filters quality, scores unusual moves within category, returns a 10-market watchlist | Recommend a side or a trade |
| 2 | **News** | Attaches dated headlines to each watchlist market, flags stale, duplicate, speculative or irrelevant items | Invent an article or a fact |
| 3 | **Charts** | 24h of 15-minute closes: trend, momentum, ATR, swing levels, structure breaks, conflicts | Predict a guaranteed outcome |
| 4 | **Strategy** | One plan per candidate: side, conditional entry, invalidation, target, time limit, R:R | Size the position or relax a rule |
| 5 | **Risk** | Checks freshness, sources, spread, liquidity, R:R after costs, sizing, exposure and concentration. **Can veto any plan.** | Approve a plan by overriding a failed check |
| 6 | **Boss** | Verifies that all five reports exist and are complete, counts risk-cleared plans, refuses to average disagreements | Approve with a missing stage, resize, or change limits |

Every stage returns the same JSON envelope:

```json
{
  "agent": "scout",
  "timestamp_utc": "2026-10-19T03:30:00.000Z",
  "status": "complete | needs_data | rejected",
  "summary": "One factual sentence.",
  "evidence": [],
  "risks": [],
  "next_step": "What the next stage should review.",
  "meta": {}
}
```

A `needs_data` stage halts the pipeline; the Boss can then only WAIT or REJECT.
A failed market inside a stage is dropped with a recorded reason — it does not stop the whole desk.

## How a plan is built

The Strategy agent only acts when charts and structure agree. It then writes **one conditional setup**:

- **Pullback** — buy the supported trend at `support + 0.25 ATR`.
- **Breakout** — buy the quote when the structure break holds.
- **Breakout retest** — if the move is stretched, wait for a retest of the broken level instead of chasing.
- **Reversal** — only when a range reclaims its high with momentum.

Every plan carries an **entry zone**, **invalidation**, **target**, **time limit**, **gross R:R** and a
**confidence score**. There is no “buy now because the model says so”.

## The risk gate

Defaults (all editable in the sidebar, all hard-coded as paper-only):

| Limit | Default |
|---|---|
| Mode | `paper` (not editable) |
| Live orders | `false` (not editable) |
| Bankroll | $1,000 |
| Risk per trade | 2% of bankroll, derived from stop distance |
| Max total exposure | 25% of bankroll |
| Max open positions | 5 |
| Max per category / event | 2 / 1 |
| Min liquidity | $2,000 |
| Max spread | 0.05 |
| Min net R:R | 1.5 |
| Max stop distance | 0.12 |
| Max entry distance from quote | 0.12 |
| Max pullback distance | 0.05 |
| Stop vs spread | stop must be at least as wide as the spread |
| News | at least one fresh dated source required |
| High event risk | block |
| Medium event risk | halve size |

The gate charges half the spread plus a configurable cost buffer on entry, tests **net** R:R, and sizes
the position from the invalidation distance — not from a fixed notional. It also refuses duplicate
questions and correlated contracts on the same event.

## Test data disclaimer

Test mode generates 520 markets across sports, politics, crypto, macro, culture and weather. It uses a
seeded random generator, a 24-hour synthetic price path per market, and synthetic headline titles.
Every surface says **SYNTHETIC TEST DATA**. The generator produces trends on purpose, so approval rates
in test mode are **not** evidence of live performance. “New day” advances the seed; different synthetic
days produce approvals, waits and vetoes.

Paper results do not prove an edge. Real trading adds fees, slippage, latency, oracle/resolution risk
and competing bots. Judge any strategy on hundreds of logged paper trades, after costs, against a
benchmark — and even then, past paper results do not guarantee future returns.

## Project layout

```
Tradebot/
├── public/
│   ├── index.html            the desk
│   ├── assets/
│   │   ├── app.js            dashboard, journal, run controls
│   │   ├── data.js           live + synthetic data layer
│   │   └── agents.js         six agents, risk gate, pipeline, schema
│   └── legacy/               the original BTC 5-minute paper bot
├── docs/
│   ├── REVIEW.md             critical review of the Google Doc setup
│   ├── HOW_IT_WORKS.md       the model, the rules, the limits
│   └── LEGACY_BTC_BOT.md     notes for the old single-market bot
├── tools/local-server.py     static server + read-only proxies
├── tests/desk.test.mjs       19 pipeline tests
├── vercel.json               static deploy + read-only relays
└── package.json              test script only
```

## Safety

- No private keys, API secrets, wallet code or order endpoints exist in this repository.
- Do not add brokerage credentials or live-trading keys to any file here.
- Mode and live-order lock are hard-coded; the dashboard cannot enable them.
- The local server rejects every non-GET request with `405`.
- Prediction-market access is restricted in some jurisdictions. This is educational software, not
  financial advice, and not a solicitation to trade.

## License and origin

The original single-market BTC 5-minute paper bot is preserved under `public/legacy/`.
The six-agent desk, its data layer and tests were added on top of it. No performance claim is made.
