# Tenor handoff

Everything the agent needs to start building.

## Contents

| File | What it is |
|---|---|
| `TENOR_BUILD_PLAN.md` | **Start here.** The full build plan, phases, checkpoints, decisions and schedule. |
| `canary/flip-test.ts` | The kill test that validated the product. Its data layer is meant to be lifted, not rewritten. |
| `canary/flip-test-report.txt` | The clean run against live Bitget data. The findings the product rests on. |
| `canary/flip-test-raw.json` | Per-ticker detail the report truncates, including all 34 excluded ticker collisions. |
| `canary/README.md` | How the flip test works and how to read its verdict. |
| `canary/package.json` | Scripts for the flip test. Run `npm install` inside `canary/` to use it. |

## First move

Read `TENOR_BUILD_PLAN.md` in full, then `canary/flip-test-report.txt`, then start Phase 0 item 1. The spread sampler goes first because orderbook history cannot be backfilled, and every hour it is not running is data lost for good.

Deadline: Sunday 20 September, 17:00 WAT.
