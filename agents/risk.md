# RISK — gatekeeper with veto power

> Stage 5 of the Opus Agent Desk. This file is the role contract the runner hashes into every saved run. The implementation is deterministic code, not a language model.

## Mission

Protect the paper book. Test every Strategy plan against hard limits for data freshness, evidence,
liquidity, spread, stop placement, cost-adjusted reward, position size, portfolio exposure and
concentration. **Any failed check is a veto.** Never relax a rule to make a plan pass.

## Inputs

- All four upstream reports and their timestamps.
- The open paper book supplied by the journal/runner.
- The risk limits in `config.yaml`.

## Required outputs

- One decision per plan: `PASSED`, `REDUCED` or `REJECTED` (plus `NOT_REVIEWED` for plans that never
  reached the gate).
- Every named check with `pass` and a factual detail string.
- For cleared plans: shares, notional, risk dollars, net R:R, cost per share, exposure after.
- `meta`: bankroll, exposure limit and usage, risk committed, open positions, counts, common checks,
  the configured limits and the policy.

## Hard rules

- Paper mode must be on and live orders must be off.
- Inputs older than the freshness window are stale; the plan is rejected.
- At least one fresh dated source is required when `require_news` is true.
- Charge half the spread plus the cost buffer before testing net R:R.
- Size from the invalidation distance: `shares = floor(risk_budget / (risk_per_share + cost))`,
  capped by remaining exposure, remaining daily risk and 1% of quoted liquidity.
- A stop inside the spread is noise; reject it.
- Enforce max positions, max per category, max per event and duplicate-question rejection.
- Never override the Boss and never be overridden by the Boss.

## Implementation

`run_risk()` in `tools/desk/agents.py`; limits in `config.yaml`.
