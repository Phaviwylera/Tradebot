# How it works

**Window.** Each market asks whether BTC ends a 5-minute window at or above its starting price. The bot records the price at each window start and waits for the next full window before trading.

**Fair probability.** `P(Up) = Φ( ln(S / S0) / (σ · √T) )`, where S is the current price, S0 the window start price, T the seconds left, and σ the recent per-second volatility from the last 90 seconds.

**Edge.** Edge = fair probability − Polymarket buy price − fee buffer. The bot buys the better side only if the edge is above your minimum, with at least the chosen number of seconds left, and only once per window.

**Risk controls.** Stake is a percentage of bankroll. Trading halts when the daily loss limit is reached.

## Known limits
- Polymarket resolves on its own price source, which can differ from Binance.
- Demo mode uses a simulated lagging market, so its profit is built in and proves nothing.
- Taker fees and spreads can erase a small edge.
- Latency from a home connection is far higher than from professional setups.
