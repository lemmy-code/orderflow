# orderflow agent — design spec

*2026-10-12 · designed in conversation, sections 1–2 approved. Builds on orderflow (spec 2026-10-07).*

## 1. Purpose

Add the "AI side" to orderflow: an **MCP server** over the orders API and an **application that drives a model** through
it, in two versions (a hand-written loop on the Anthropic SDK, and the Claude Agent SDK). It exists so Dimitrije can show,
explain and defend, by **Wednesday 14 October 2026, 16:00** (Teamcubate interview), every point in the Teamcubate ad:

- building LLM applications that call tools, with an SDK and with a custom execution loop;
- writing MCP servers and tool interfaces with clear schemas and validation;
- tool descriptions that make the model pick the right action with valid arguments;
- workflow control: execution limits, permissions, human approval steps;
- debugging incorrect tool selection, invalid arguments and incomplete execution;
- testing, regression checks and evaluating model output;
- Claude Agent SDK and the Anthropic API (preferred).

**Success:** a live demo he can run on a screen share; CI green with no API key; a study guide (HTML) he has read, with
interview questions answered; every claim in the README true.

## 2. Architecture

```
you ──▶ orderflow-agent (Anthropic SDK, hand-written loop + policy) ──stdio/MCP──▶ orderflow-mcp ──HTTP──▶ orders GraphQL
you ──▶ orderflow-agent-sdk (Claude Agent SDK, same policy)          ──stdio/MCP──▶ orderflow-mcp
```

| Unit | What it does | Depends on |
|---|---|---|
| `apps/mcp-server` (`orderflow-mcp`) | MCP server over stdio. Tools `list_products`, `create_order`, `get_order`, `list_orders`, `pay_order`, `cancel_order`, each with a Zod input schema and a description written for the model. Calls orders GraphQL; maps its error codes to MCP tool errors. | `@modelcontextprotocol/sdk`, zod, orders API |
| `apps/agent` (`orderflow-agent`) | CLI that drives Claude: tool-use loop, policy (permissions, approvals, limits, budget), trace. Talks to the MCP server as a client. | `@anthropic-ai/sdk`, MCP client |
| `apps/agent-sdk` (`orderflow-agent-sdk`) | The same task on the Claude Agent SDK: same MCP server, same permission tiers via its permission callback, turn limit. | `@anthropic-ai/claude-agent-sdk` |
| `libs/agent-policy` | Shared, pure: tool tiers, the permission decision, step/budget accounting. Used by both agents so the rules are defined once. | — |

The agent never calls GraphQL directly: everything the model can do goes through the MCP server, so the tool surface is
one reviewed place. The MCP server holds no state.

## 3. Tools (the model-facing contract)

| Tool | Tier | Input | Result |
|---|---|---|---|
| `list_products` | read | — | seeded catalogue: id, sku, name, price (static; stock lives in inventory, which has no API) |
| `create_order` | write | `items: {productId: uuid, quantity: int 1–1000}[]` (1–50) | order id + status (`PENDING`) |
| `get_order` | read | `orderId: uuid` | status, total, rejection reason, items |
| `list_orders` | read | `status?`, `first?` (1–100) | orders, newest first (the server pages through the API) |
| `pay_order` | **approval** | `orderId: uuid` | new status |
| `cancel_order` | **approval** | `orderId: uuid` | new status |

Descriptions state what the tool does, when to use it, and the async fact that matters: an order is `PENDING` for a few
seconds until inventory answers, so call `get_order` again before paying. Errors come back as `isError: true` with the
API's code (`BAD_USER_INPUT`, `NOT_FOUND`, `INVALID_STATE`) and a one-line hint, so the model can recover.

## 4. The hand-written agent

**Loop:** send system prompt + conversation + tool list → if `stop_reason` is `tool_use`, handle every `tool_use` block
(policy, then call), append `tool_result` blocks, repeat → stop on `end_turn`, a limit, or an error.

**Policy, checked before every call:**
- unknown tool → refused, the model is told which tools exist;
- **read** tools run; **write** tools run; **approval** tools ask a human (`y/N` in the terminal, default no). A denial is
  returned to the model as a tool result: "the user denied this action — do not retry it another way";
- limits: max **12** model steps per task, max **60,000** tokens per task, cost estimated from `usage` and printed;
- arguments are validated by the server's Zod schema; the agent forwards the server's validation error to the model.

**Model:** `AGENT_MODEL`, default `claude-sonnet-5-5`. **Resilience:** the SDK's built-in retries for 429/5xx; MCP
transport closing ends the run cleanly with the trace kept.

**Trace:** one JSON line per event (model call with tokens, tool request, policy decision, tool result, timing) under
`.agent-traces/` (git-ignored). `--trace` prints it live. This is what you use to explain or debug a run.

**Seams for testing:** the model is behind a `ModelClient` interface, tools behind a `ToolGateway` interface, approval
behind an `Approver` interface, so the loop runs in tests with a scripted fake model and no network.

## 5. The Claude Agent SDK version

Same prompt, same MCP server (configured as an `mcpServers` entry), `maxTurns` for the step limit, and a permission
callback that applies the same tiers from `libs/agent-policy` (approval tools prompt in the terminal). It exists to compare:
the README and study guide state when you'd write your own loop (full control, custom policy, any model) and when you'd
use the framework (built-in context management, tools, sessions; less code).

## 6. Testing and evaluation

- **Unit (CI):** policy decisions; the loop with a fake model — happy path, approval denied, step limit, budget limit,
  unknown tool, invalid arguments then recovery, tool error then recovery, transport failure.
- **Integration (CI):** the MCP server over an in-memory MCP transport against the real orders app (Testcontainers
  PostgreSQL, messaging off): tool list and schemas, `create_order` → `get_order`, error mapping for each code.
- **Agent end to end (CI):** the hand-written agent with a scripted fake model, through the real MCP server, against the
  real orders app: creates an order and stops at a denied payment.
- **Eval (local, `npm run eval`, needs `ANTHROPIC_API_KEY`):** ~8 natural-language tasks against the real model; each
  checks the tool sequence and arguments (e.g. "order 2 keyboards" → `list_products` then `create_order` with quantity 2;
  "pay order X" → asks approval). Prints a pass/fail table; not in CI (costs money, non-deterministic).
- The Agent SDK version gets a smoke script, not CI tests (it needs the real model).

## 7. Documentation

- README: a new "AI agent" section with the diagram, how to run the MCP server and both agents, and an example trace.
- `docs/agent/LEARN.md` (+ `.html`): the concepts in plain words — tool use and the loop, `stop_reason`, `tool_use` /
  `tool_result`, MCP (tools, resources, prompts; stdio vs Streamable HTTP; client vs server), permissions and approvals,
  writing tool descriptions, limits and cost, evals, hand-written loop vs Agent SDK — and interview questions with answers.

## 8. Scope

**Out:** web UI, stored conversations, multi-user auth, cloud deployment, Streamable HTTP transport (explained in the
guide, not built), changes to orders or inventory behaviour.

**Constraint:** CI stays green with no API key and no `.env`; nothing reads an env var at import time.
