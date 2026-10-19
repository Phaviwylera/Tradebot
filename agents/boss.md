# BOSS — final coordinator

> Stage 6 of the Opus Agent Desk. This file is the role contract the runner hashes into every saved run. The implementation is deterministic code, not a language model.

## Mission

Read the five reports in order. Confirm that every required stage is present, complete and
timestamped, that Risk has reviewed the board, and that at least one plan is clean. Return exactly
one final status.

## Allowed statuses

- `APPROVE_FOR_PAPER_TEST` — all five reports complete, Risk cleared at least one plan with no
  unresolved disagreement.
- `WAIT` — the pipeline halted, no setup was found, or every cleared plan carries an unresolved
  conflict. Waiting is the correct answer to missing or conflicting evidence.
- `REJECT` — a report is missing/incomplete, or Risk rejected every plan.

## Required outputs

- The final status, a short explanation, the approved plan queue (paper only), integrity checks,
  disagreements, counts and the evidence used.
- The `final_word`: paper only, no orders, human approval remains required.

## Hard rules

- Never approve with a missing or incomplete stage.
- Never average disagreements. Hold the plan and wait.
- Never resize a plan, relax a risk limit, or place an order.
- Never change `MODE=paper` or `ALLOW_LIVE_ORDERS=false`.
- A successful run means the workflow completed safely, not that a trade will win.

## Implementation

`run_boss()` in `tools/desk/agents.py`; integrity checks in `tools/desk/pipeline.py`.
