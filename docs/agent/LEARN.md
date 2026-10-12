# How an AI agent works — a study guide built on orderflow

Everything here points at real code in this repository. Read it next to the code: `apps/agent/src/loop.ts` (the loop),
`apps/mcp-server/src/tools.ts` (the tools), `libs/agent-policy/src` (the rules), `apps/agent-sdk/src/main.ts` (the framework
version).

## 1. What "an application that drives a model" means

A model on its own only produces text. An agent is **your program** that lets the model *act*: it tells the model which
tools exist, runs the ones the model asks for, and feeds the results back, until the model is done.

**The loop, in six steps** (`runAgent` in `apps/agent/src/loop.ts`):

1. Send the model the **system prompt** (the rules), the **conversation**, and the **list of tools** (name, description,
   JSON Schema of the input).
2. The model answers with content blocks and a **`stop_reason`**.
3. If `stop_reason` is **`tool_use`**, the content contains one or more `tool_use` blocks: *"call `create_order` with
   these arguments"*.
4. **Your code** decides whether that is allowed, runs the tool, and collects the result.
5. You send every result back as a `tool_result` block in the next user message, and go to step 2.
6. When `stop_reason` is **`end_turn`**, the model is finished: its text is the answer.

**The `stop_reason` values** the Anthropic API returns, and what our agent does:

| `stop_reason` | Meaning | orderflow-agent |
|---|---|---|
| `tool_use` | the model wants tools run | run them, loop |
| `end_turn` | the model finished normally | outcome `done` |
| `max_tokens` | the reply hit the output limit mid-answer | outcome `incomplete` — never pretend it finished |
| `refusal` | the model declined | outcome `incomplete` |
| `stop_sequence`, `pause_turn`, `model_context_window_exceeded` | other stops | outcome `incomplete` with the reason |

**The key point to say in an interview:** the model never runs anything. It *asks*. Your code is in charge of what
actually happens, which is where safety, limits and logging live.

## 2. `tool_use` and `tool_result` in detail

The model's reply (simplified):
```json
{ "stop_reason": "tool_use",
  "content": [
    { "type": "text", "text": "Let me find the keyboard." },
    { "type": "tool_use", "id": "toolu_01", "name": "list_products", "input": {} } ] }
```

What you send back, as the **next user message**:
```json
{ "role": "user", "content": [
    { "type": "tool_result", "tool_use_id": "toolu_01", "content": "[{\"id\":\"1111…\",\"name\":\"Mechanical keyboard\"}]" } ] }
```

Rules that matter:
- **Every `tool_use` gets exactly one `tool_result`** with the same id. The model can ask for **several tools in one
  reply**; answer them all, in order, in **one** user message (test: *"handles several tool calls in one reply"*).
- A failure is still a result: set **`is_error: true`** and explain in `content`. The model reads it and can correct
  itself (test: *"passes a tool error back to the model so it can recover"*).
- You must send the assistant's reply back in the history unchanged, so the model sees its own `tool_use` blocks next
  to your results.

## 3. MCP — the Model Context Protocol

MCP is a standard way to give tools (and data) to an AI application, so tools are written once and any MCP client can
use them: Claude Desktop, Claude Code, Cursor, our agent.

- **Server** = offers capabilities (`apps/mcp-server`). **Client** = the application that uses them
  (`apps/agent/src/mcp-gateway.ts`).
- **Three primitives:** **tools** (actions the model can call — what we use), **resources** (data the application can
  read, like files), **prompts** (reusable prompt templates).
- **Transports:** **stdio** — the client starts the server as a child process and they talk over stdin/stdout; simple,
  local, one client (what we use). **Streamable HTTP** — the server runs as a web service; many clients, remote, needs
  auth. (The older SSE transport is replaced by Streamable HTTP.)
- Because stdout *is* the protocol on stdio, the server must log to **stderr** only (`apps/mcp-server/src/main.ts`).
- `listTools()` returns each tool's name, description and **JSON Schema**. We write the schema in **Zod**; the SDK
  converts it.
- **Errors come back as results, not exceptions.** We checked this against the real SDK: invalid arguments, an unknown
  tool, or a thrown error all reach the client as `{ isError: true, content: [{ type: "text", text: "…" }] }`. So the
  model sees the error and can fix its arguments.

## 4. Writing tools a model uses well

The model chooses tools from their **names, descriptions and schemas** alone. That makes them a contract, and our six
tools (`apps/mcp-server/src/tools.ts`) show the rules:

1. **Say when to use it, not just what it does.** `list_products`: *"Call this first whenever the user names a product,
   to get its productId; never guess ids."*
2. **Tell the model the facts it can't guess.** `create_order` explains that orders start `PENDING` and become
   `RESERVED` or `REJECTED` after a few seconds; `pay_order` says only `RESERVED` orders can be paid.
3. **Schemas are guard-rails.** `quantity` is an integer from 1 to 1000; ids must be UUIDs. Bad input is rejected
   *before* it reaches the API.
4. **Error messages that say what to do next.** Every API error code maps to a hint (`HINTS` in `tools.ts`): for
   `INVALID_STATE`, *"Call get_order to see the current status. A PENDING order cannot be paid until it is RESERVED."*
   That is the difference between an agent that recovers and one that gives up.
5. **Small, typed tools.** The model gets six clear actions, not raw access to the database or the GraphQL API.

## 5. Control — making an agent safe

This is the part interviewers care about most (`libs/agent-policy`, `apps/agent/src/loop.ts`).

- **Tiers.** `read` tools run freely; `write` (`create_order`) runs; `approval` (`pay_order`, `cancel_order`) needs a
  human. Defined once in `TOOL_TIERS`, used by both agents.
- **Default deny.** A tool on the server *without* a tier is hidden from the model and refused if requested (test:
  *"only shows tiered tools to the model"*). Adding a dangerous tool to the server can't silently give the model new powers.
- **Human approval.** The terminal asks `Allow? [y/N]`; only `y`/`yes` approves, Enter means no
  (`parseApproval`). A denial goes back to the model as: *"The user denied this action. Do not retry it or try to achieve
  the same result another way."* Without that sentence a model may try a workaround.
- **Limits.** 12 model steps and 60,000 tokens per task (`Budget`). That stops loops and runaway cost. The outcome is
  `limit` with the reason (`steps` or `tokens`).
- **Truncation.** Tool results over 20,000 characters are cut, with a marker, so one huge result can't blow the budget.
- **Resilience.** The Anthropic SDK retries rate limits (429) and server errors (5xx) with backoff (`maxRetries: 3`).
  If the MCP connection dies, the run ends with outcome `error` and the trace is kept.

## 6. Debugging with the trace

Every run writes `.agent-traces/<time>.jsonl`, one event per line: `task`, `model` (step, `stop_reason`, tokens, text),
`tool_request`, `policy` (the decision), `tool_result` (error or not, milliseconds, preview), `end`.
`npm run agent -- --trace "…"` also prints them live.

Three failures and how the trace shows them:
- **Wrong tool chosen** (e.g. `create_order` before `list_products`, with a guessed id): visible as the order of
  `tool_request` events. Fix the tool **description** or the **system prompt**, then add an eval case.
- **Invalid arguments** (e.g. `quantity: 0`): a `tool_result` with `isError: true` and the validation message; the next
  `tool_request` should show the corrected call. If it repeats the mistake, the error message needs a better hint.
- **Gave up early / incomplete**: an `end` event with outcome `incomplete` and `stop_reason` `max_tokens` — raise
  `maxTokensPerReply` or make tool results smaller.

## 7. Testing and evaluation

- **A fake model** (`test/support/fake-model.ts`) plays back scripted replies. The loop, policy, approvals, limits and
  errors are tested without a network or an API key, deterministically, in CI (`apps/agent/src/loop.spec.ts`).
- **The MCP server** is tested over an in-memory MCP transport, with a fake API (`tools.spec.ts`) and against the real
  orders API in Docker (`test/int/mcp-server.int-spec.ts`).
- **End to end**: a scripted model, the real MCP server and the real API: list products → create order → payment denied
  (`test/int/agent.int-spec.ts`).
- **The eval** (`npm run eval`, `eval/cases.ts`) runs 8 real tasks against the real model and checks *behaviour*: the
  right tools, in the right order, with the right arguments, and no unapproved writes. It is not in CI because it costs
  money and the model is not deterministic; you run it after changing a prompt, a tool description or the model.

## 8. Hand-written loop vs Claude Agent SDK

| | Hand-written (`apps/agent`) | Claude Agent SDK (`apps/agent-sdk`) |
|---|---|---|
| The loop | ~120 lines you own | provided by `query()` |
| Permissions | `decide()` before each call | the `canUseTool` callback, using the same `decide()` |
| Limits | `Budget` (steps and tokens) | `maxTurns` |
| Built-in tools | none | many (files, shell…) — we switch them all off with `tools: []` |
| Settings | none | `settingSources: []` so your own Claude settings don't leak in |
| Tool names | `create_order` | `mcp__orderflow__create_order` |
| Tests | fake model, fully deterministic | needs the real model |
| Cost and turns | our estimate from `usage` | reported in the final `result` message (`num_turns`, `total_cost_usd`) |

**When to choose which:** write your own loop when you need full control — custom policy, your own logging and tests,
any provider or model. Use the Agent SDK when you want a capable agent quickly — it brings the loop, context management,
built-in tools and sessions — and you're happy to express your rules through its hooks.

## 9. Interview questions and short answers

1. **How does a tool-calling agent work?** — A loop: the model gets the tools, replies with `stop_reason: tool_use` and
   `tool_use` blocks, my code runs them and returns `tool_result`s, until `end_turn`.
2. **Who executes the tool — the model or you?** — My code. The model only asks; that's where permissions, validation
   and logging go.
3. **What if the model asks for a tool that doesn't exist?** — Refused before the server; the model gets an error listing
   the tools that do exist.
4. **The model sent invalid arguments — what happens?** — The Zod schema rejects them on the MCP server; the model gets
   `isError` with the reason and usually corrects itself on the next step.
5. **How do you make a destructive action safe?** — Tiers with default deny, human approval with a default of no, and a
   denial message telling the model not to find a workaround.
6. **How do you stop an agent from looping or burning money?** — A step limit and a token budget per task, truncation of
   big tool results, and a trace to see why it looped.
7. **Why validate on the server if the model already has the schema?** — The schema is a hint, not a guarantee. Models
   can still send wrong values, and other clients may call the server too.
8. **What makes a good tool description?** — When to use it, what it needs, facts the model can't guess (like async
   status), and errors that say how to recover.
9. **stdio or Streamable HTTP?** — stdio for a local server started by one client; Streamable HTTP for a shared, remote
   server with many clients and auth.
10. **What are MCP resources and prompts?** — Resources are readable data the app can attach; prompts are reusable
    templates. Tools are actions. orderflow uses tools.
11. **How do you test an agent?** — Deterministic tests with a fake model for the loop and the rules, integration tests
    for the tools against the real API, and an eval with the real model for behaviour.
12. **What's an eval and why not just unit tests?** — The model isn't deterministic, so you check behaviour over a set of
    tasks: right tool, right order, valid arguments, nothing unsafe. You re-run it after changing prompts, tools or models.
13. **How do you debug a wrong tool choice in production?** — Read the trace: the sequence of `tool_request`s and the
    arguments. Usually the fix is the tool description or the system prompt, then you add an eval case for it.
14. **What happens on a 429 from the API?** — The SDK retries with exponential backoff (`maxRetries`); after that the run
    ends with an error and the trace is kept.
15. **`max_tokens` stop reason — what do you do?** — Treat it as incomplete, never as done; raise the output limit or
    reduce what you ask for.
16. **Hand-written loop or Agent SDK?** — Own loop for control and testability; the SDK for speed and built-in tools. I
    built both with the same policy to compare.
17. **How does the agent wait for an async process?** — The tool description says orders start `PENDING`; the model
    calls `get_order` again until `RESERVED` before paying, within the step limit.

## 10. How to talk about building it

Say it plainly: *"I designed it — the tools, the tiers, the limits — wrote the spec and the plan, and built it with Claude
Code as my development tool, test-first, with an independent review at the end. I can walk you through any file."* Then
be able to: open `loop.ts` and explain the six steps; open `tools.ts` and explain one description and one error hint;
run the tests; and show a trace.

**Try it yourself before the interview:**
1. `npm run test:unit -- apps/agent` and read each test name in `loop.spec.ts` — every one is an interview answer.
2. Read `loop.ts` top to bottom and say each step out loud.
3. With a key in `.env` and `docker compose up --wait`: `npm run agent -- --trace "order 2 keyboards and pay for it"`,
   answer `y` once and `n` once, then open the newest file in `.agent-traces/`.
4. `npm run eval` and look at which tools the model chose for each case.
