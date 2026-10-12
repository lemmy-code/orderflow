import { Budget, decide, DEFAULT_LIMITS, hasTier, Limits, MAX_TOOL_RESULT_CHARS } from '@app/agent-policy';
import { SYSTEM_PROMPT } from './prompt';
import { Approver, Message, ModelClient, ToolGateway, ToolResultBlock, ToolUseBlock, TraceSink } from './types';

export interface AgentDeps {
  model: ModelClient;
  tools: ToolGateway;
  approver: Approver;
  trace: TraceSink;
  limits?: Limits;
  system?: string;
  maxTokensPerReply?: number;
}

export interface RunResult {
  outcome: 'done' | 'incomplete' | 'limit' | 'error';
  reason?: string;
  text: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
}

const now = () => new Date().toISOString();
const truncate = (s: string) =>
  s.length <= MAX_TOOL_RESULT_CHARS
    ? s
    : `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} characters]`;
const DENIED_BY_HUMAN =
  'The user denied this action. Do not retry it or try to achieve the same result another way; tell the user it was not done.';

/** The tool-use loop: model → policy → tool → result → model, until the model finishes or a limit is hit. */
export async function runAgent(task: string, d: AgentDeps): Promise<RunResult> {
  const budget = new Budget(d.limits ?? DEFAULT_LIMITS);
  const finish = (r: Omit<RunResult, 'steps' | 'usage'>): RunResult => {
    const result = {
      ...r,
      steps: budget.steps,
      usage: { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens },
    };
    d.trace.write({ type: 'end', at: now(), outcome: result.outcome, reason: result.reason, steps: result.steps, usage: result.usage });
    return result;
  };

  let lastText = '';
  try {
    // Only reviewed (tiered) tools are shown to the model; anything else on the server stays invisible.
    const specs = (await d.tools.listTools()).filter((t) => hasTier(t.name));
    const exposed = new Set(specs.map((t) => t.name));
    const messages: Message[] = [{ role: 'user', content: task }];
    d.trace.write({ type: 'task', at: now(), task, tools: [...exposed] });

    for (;;) {
      const out = budget.exhausted();
      if (out) return finish({ outcome: 'limit', reason: out, text: lastText });

      const r = await d.model.create({
        system: d.system ?? SYSTEM_PROMPT,
        messages,
        tools: specs,
        maxTokens: d.maxTokensPerReply ?? 16_000, // thinking counts toward this, so leave room
      });
      budget.record(r.usage);
      lastText = r.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      d.trace.write({ type: 'model', at: now(), step: budget.steps, stopReason: r.stopReason, usage: r.usage, text: lastText });
      // The reply goes back exactly as received: models that think require their thinking blocks unchanged.
      messages.push({ role: 'assistant', content: r.raw ?? r.content });

      if (r.stopReason !== 'tool_use') {
        return r.stopReason === 'end_turn'
          ? finish({ outcome: 'done', text: lastText })
          : finish({ outcome: 'incomplete', reason: r.stopReason ?? 'unknown', text: lastText });
      }

      // Every tool_use in the reply gets exactly one tool_result, in order, all in one user message.
      const results: ToolResultBlock[] = [];
      for (const use of r.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')) {
        d.trace.write({ type: 'tool_request', at: now(), id: use.id, tool: use.name, input: use.input });
        const decision = decide(use.name, exposed);
        if (decision.kind === 'deny') {
          d.trace.write({ type: 'policy', at: now(), id: use.id, tool: use.name, decision: 'deny', reason: decision.reason });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: decision.reason, is_error: true });
          continue;
        }
        if (decision.kind === 'ask') {
          const ok = await d.approver.approve({ tool: use.name, input: use.input, reason: decision.reason });
          d.trace.write({
            type: 'policy',
            at: now(),
            id: use.id,
            tool: use.name,
            decision: ok ? 'approved-by-human' : 'denied-by-human',
          });
          if (!ok) {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: DENIED_BY_HUMAN, is_error: true });
            continue;
          }
        } else {
          d.trace.write({ type: 'policy', at: now(), id: use.id, tool: use.name, decision: 'allow' });
        }
        const started = Date.now();
        const res = await d.tools.call(use.name, use.input);
        const content = truncate(res.text);
        d.trace.write({
          type: 'tool_result',
          at: now(),
          id: use.id,
          tool: use.name,
          isError: res.isError,
          ms: Date.now() - started,
          preview: content.slice(0, 300),
        });
        results.push({ type: 'tool_result', tool_use_id: use.id, content, ...(res.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    return finish({ outcome: 'error', reason: e instanceof Error ? e.message : String(e), text: lastText });
  }
}
