# orderflow agent — task log

Every task gets a line when it **starts** and is updated when it **ends**. Times are local (CEST), taken from the clock and
the commit that closed the task. Plan: `docs/superpowers/plans/2026-10-12-orderflow-agent.md`.

| # | Task | Started | Finished | Result | Commit |
|---|---|---|---|---|---|
| — | Design spec (brainstorming, 2 sections approved) | Mon 12.10 ~14:50 | Mon 12.10 15:15 | approved | `eddf4e3` |
| — | Implementation plan (APIs checked against installed SDKs) | Mon 12.10 15:15 | Mon 12.10 15:22 | approved ("lets do it") | `0c16b4e` |
| 1 | Dependencies + `libs/agent-policy` (tiers, approvals, limits, cost) | Mon 12.10 15:22 | Mon 12.10 15:26 | ✅ 22 tests pass | `02ce7f9` |
| 2 | `orderflow-mcp`: MCP server, 6 tools, Zod schemas, error hints | Mon 12.10 15:26 | Mon 12.10 15:27 | ✅ 7 tests pass | `1db7967` |
| 3 | MCP server tests against the real orders API (Docker) | Mon 12.10 15:27 | Mon 12.10 15:28 | ✅ 4 tests pass | `fd61f39` |
| 4 | Agent loop: policy, approvals, limits, truncation, trace | Mon 12.10 15:28 | Mon 12.10 15:29 | ✅ 12 tests pass | `7a0c667` |
| 5 | Real adapters (Anthropic SDK, MCP stdio, y/N approval, JSONL trace, CLI) + end-to-end test | Mon 12.10 15:29 | Mon 12.10 15:30 | ✅ e2e passes; stdio smoke: 6 tools, bad args → isError | `33a5356` |
| 6 | Claude Agent SDK version | Mon 12.10 20:45 | Mon 12.10 20:46 | ✅ typecheck against the real SDK types; no-key run exits cleanly. ⚠️ **live run not verified yet (no API key)** | `c48bbf7` |
| 7 | Eval: 8 tasks against the real Claude | Mon 12.10 20:46 | Mon 12.10 20:46 | ✅ lint/types; all 8 checks verified with simulated good and bad runs (good → pass, bad → caught). ⚠️ **not run against the real model yet (no API key)** | `888d7c8` |
| 8 | README section + LEARN study guide + full suite | Mon 12.10 20:47 | Mon 12.10 20:50 | ✅ lint, types, 100 unit + 41 integration + 7 e2e = **148/148**, also from a fresh clone with no .env | `b277ceb` |

**Decisions made while building** (also in the ledger):
- Task 1: TypeScript/Nest settings unchanged; the three SDKs installed: `@anthropic-ai/sdk` 0.133, `@modelcontextprotocol/sdk` 1.32, `@anthropic-ai/claude-agent-sdk` 0.3, `zod` 4.
- Task 2: tests read `callTool` results as `unknown` — the SDK's result type also allows an older `toolResult` shape.
- Task 6: the Agent SDK version reuses the hand-written agent's policy (`decide`), approval prompt and system prompt, so both agents follow identical rules.
- Task 7: the eval denies every approval, so a live eval never pays or cancels anything; the "over the limit" case checks that the model *explains* the 1000-per-line limit.
- Task 5: the end-to-end "model" counts assistant turns instead of wrapping the fake model (same behaviour, simpler).

## Still open

| What | Status |
|---|---|
| Final review by an independent reviewer (most capable model) | Mon 12.10 20:50 → 20:55: **1 critical, 4 important, 8 minor** — see Fix pass |
| Fix pass (critical + important, each with a failing test first) | started Mon 12.10 20:55 |
| Merge `feat/agent` into `main` and push; CI green on GitHub | after the review |
| **Live run with the real Claude** (`npm run agent`, `npm run agent:sdk`, `npm run eval`) | ⚠️ needs an `ANTHROPIC_API_KEY` in `.env` — not done |
