# Tradebot

A paper-trading bot for Polymarket's BTC 5-minute Up/Down markets. It uses simulated money only: no wallet, no keys, no real orders.

The bot streams the live BTC price from Binance, estimates the true chance that BTC finishes each 5-minute window higher, compares that with the Polymarket buy price, and records simulated trades when the gap (after a fee buffer) is large enough.

> Paper results do not prove a live edge. Real trading adds fees, slippage, latency and competing bots. Judge the bot on at least a few hundred paper trades before risking any money.

## Structure

```
Tradebot/
├── public/               the web app (this is what gets deployed)
│   ├── index.html
│   └── assets/
│       ├── style.css
│       └── app.js        price feed, probability model, paper trading
├── tools/
│   └── local-server.py   run the app on your own computer
├── docs/
│   └── HOW_IT_WORKS.md   the model and its limits
├── vercel.json           deploy config and Polymarket data relay
└── README.md
```

## Deploy on Vercel
1. Import this repository in Vercel (Add New > Project).
2. Leave the settings at their defaults and deploy. `vercel.json` serves `public/` and relays `/gamma` and `/clob` to Polymarket's public APIs.

## Run locally
Install Python, then run `python tools/local-server.py`. The app opens at http://localhost:8765.

## Safety
Never put a private key or API secret in any file in this repository. Hosted pages and public repositories are visible to everyone.
