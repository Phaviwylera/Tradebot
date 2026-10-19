# Fixture data

`fixtures.json` is a **synthetic board**, not a market snapshot. Every record carries
`"synthetic": true` and the payload is labelled:

```json
{
  "label": "SYNTHETIC TEST DATA",
  "note": "Generated board. Not a real market and not a forecast.",
  "seed": 15,
  "generated_at": "2026-10-19T04:02:20Z",
  "markets": [ ... 520 records ... ]
}
```

Regenerate it with:

```bash
python main.py --build-fixtures --seed 15
```

The generator (`generate_universe` in `tools/desk/data.py`) is deterministic: the same seed gives the
same 520 questions, prices and volumes. It is a mulberry32 PRNG with no relation to any real event.

## Record shape

The records intentionally mimic the public Gamma `/markets` fields the live loader consumes, so the
same normaliser handles both paths:

| Field | Purpose |
|---|---|
| `id`, `conditionId`, `slug` | stable identifiers |
| `question`, `description`, `resolutionSource` | market text; the description says SYNTHETIC TEST MARKET |
| `outcomes`, `outcomePrices`, `clobTokenIds` | JSON-encoded strings, as Gamma returns them |
| `bestBid`, `bestAsk`, `spread`, `lastTradePrice` | quote; the normaliser derives mid price and `has_quote` |
| `liquidityNum`, `volume24hr`, `volume1wk`, `volumeNum` | activity |
| `oneHourPriceChange`, `oneDayPriceChange`, `oneWeekPriceChange` | Scout inputs |
| `hours_to_end`, `quote_age_min` | **relative offsets** materialised at load time, so the fixture never goes stale |
| `endDate`, `updatedAt` | absolute timestamps, kept for schema parity |
| `category` | sports / politics / crypto / econ / culture / weather / other |
| `regime` | `range`, `up`, `down` or `breakout` — drives the synthetic price series |
| `news_count`, `event_risk` | drive the synthetic headline pass |
| `synthetic`, `demo` | labelling; the dashboard and reports refuse to present this as live data |

## Rules

- Do not add real user data, API keys or private account information to this folder.
- Do not relabel the fixture as live data. `mode: paper` is not a licence to present synthetic
  prices as real ones.
- Relative timestamps are deliberate. Absolute dates would expire and quietly turn every market
  into `needs_data`.
