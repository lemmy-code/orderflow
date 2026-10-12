import { FakeModel, reply, say, toolUse } from '../../../test/support/fake-model';
import { runAgent } from './loop';
import { Approver, Message, ToolGateway, TraceEvent } from './types';

const SPECS = ['list_products', 'create_order', 'get_order', 'list_orders', 'pay_order', 'cancel_order'].map((name) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object' },
}));

function gateway(results: Record<string, { text: string; isError?: boolean }> = {}, extra: string[] = []) {
  const calls: { name: string; args: unknown }[] = [];
  const g: ToolGateway = {
    listTools: async () => [...SPECS, ...extra.map((name) => ({ name, description: 'x', inputSchema: { type: 'object' } }))],
    call: async (name, args) => {
      calls.push({ name, args });
      const r = results[name] ?? { text: `{"ok":"${name}"}` };
      return { text: r.text, isError: r.isError ?? false };
    },
  };
  return { g, calls };
}
const approver = (answer: boolean): Approver & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    approve: async ({ tool }) => {
      asked.push(tool);
      return answer;
    },
  };
};
const memoryTrace = () => {
  const events: TraceEvent[] = [];
  return { events, write: (e: TraceEvent) => void events.push(e) };
};
type SentBlock = { type: string; tool_use_id?: string; content?: string; is_error?: boolean };
const lastUserBlocks = (m: FakeModel) => {
  const msgs = m.requests.at(-1)!.messages as Message[];
  return msgs.at(-1)!.content as SentBlock[];
};
const loopForever = (n: number) => Array.from({ length: n }, (_, i) => reply([toolUse(`t${i}`, 'list_orders', {})]));

describe('runAgent', () => {
  it('runs tools until the model is done, and only shows tiered tools to the model', async () => {
    const model = new FakeModel([reply([toolUse('t1', 'list_products', {})]), reply([say('Here are the products.')])]);
    const { g, calls } = gateway({}, ['refund_order']);
    const r = await runAgent('what can I buy?', { model, tools: g, approver: approver(false), trace: memoryTrace() });
    expect(r).toMatchObject({ outcome: 'done', text: 'Here are the products.', steps: 2 });
    expect(calls.map((c) => c.name)).toEqual(['list_products']);
    expect(model.requests[0].tools.map((t) => t.name)).not.toContain('refund_order');
  });

  it('handles several tool calls in one reply, in order, answered in one message', async () => {
    const model = new FakeModel([
      reply([toolUse('a', 'get_order', { orderId: '1' }), toolUse('b', 'get_order', { orderId: '2' })]),
      reply([say('done')]),
    ]);
    const { g, calls } = gateway();
    await runAgent('check both', { model, tools: g, approver: approver(false), trace: memoryTrace() });
    expect(calls.map((c) => (c.args as { orderId: string }).orderId)).toEqual(['1', '2']);
    expect(lastUserBlocks(model).map((b) => b.tool_use_id)).toEqual(['a', 'b']);
  });

  it('asks before an approval tool and does not run it when denied', async () => {
    const model = new FakeModel([
      reply([toolUse('p', 'pay_order', { orderId: '1' })]),
      reply([say('Payment was not approved.')]),
    ]);
    const { g, calls } = gateway();
    const ap = approver(false);
    const trace = memoryTrace();
    const r = await runAgent('pay order 1', { model, tools: g, approver: ap, trace });
    expect(ap.asked).toEqual(['pay_order']);
    expect(calls).toHaveLength(0);
    expect(lastUserBlocks(model)[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/denied/) });
    expect(trace.events.some((e) => e.type === 'policy' && e.decision === 'denied-by-human')).toBe(true);
    expect(r.outcome).toBe('done');
  });

  it('runs an approval tool when the human says yes', async () => {
    const model = new FakeModel([reply([toolUse('p', 'pay_order', { orderId: '1' })]), reply([say('Paid.')])]);
    const { g, calls } = gateway();
    await runAgent('pay order 1', { model, tools: g, approver: approver(true), trace: memoryTrace() });
    expect(calls.map((c) => c.name)).toEqual(['pay_order']);
  });

  it('refuses an unknown tool without calling the server, and tells the model what exists', async () => {
    const model = new FakeModel([reply([toolUse('x', 'drop_database', {})]), reply([say('I cannot do that.')])]);
    const { g, calls } = gateway();
    await runAgent('drop it', { model, tools: g, approver: approver(true), trace: memoryTrace() });
    expect(calls).toHaveLength(0);
    expect(lastUserBlocks(model)[0]).toMatchObject({ is_error: true, content: expect.stringContaining('create_order') });
  });

  it('passes a tool error back to the model so it can recover', async () => {
    const model = new FakeModel([
      reply([toolUse('c', 'create_order', { items: [{ productId: 'kb', quantity: 0 }] })]),
      reply([toolUse('c2', 'create_order', { items: [{ productId: 'kb', quantity: 1 }] })]),
      reply([say('Ordered.')]),
    ]);
    let n = 0;
    const g: ToolGateway = {
      listTools: async () => SPECS,
      call: async () =>
        n++ === 0 ? { text: 'Input validation error', isError: true } : { text: '{"status":"PENDING"}', isError: false },
    };
    const r = await runAgent('order', { model, tools: g, approver: approver(false), trace: memoryTrace() });
    expect(r).toMatchObject({ outcome: 'done', steps: 3 });
    expect((model.requests[1].messages.at(-1)!.content as SentBlock[])[0].is_error).toBe(true);
  });

  it('stops at the step limit', async () => {
    const r = await runAgent('loop', {
      model: new FakeModel(loopForever(10)),
      tools: gateway().g,
      approver: approver(false),
      trace: memoryTrace(),
      limits: { maxSteps: 3, maxTokens: 1e9 },
    });
    expect(r).toMatchObject({ outcome: 'limit', reason: 'steps', steps: 3 });
  });

  it('stops at the token budget', async () => {
    const r = await runAgent('loop', {
      model: new FakeModel(loopForever(10)),
      tools: gateway().g,
      approver: approver(false),
      trace: memoryTrace(),
      limits: { maxSteps: 100, maxTokens: 250 },
    });
    expect(r).toMatchObject({ outcome: 'limit', reason: 'tokens' });
  });

  it.each(['max_tokens', 'refusal'])('reports stop reason %s as incomplete, not done', async (stop) => {
    const r = await runAgent('x', {
      model: new FakeModel([reply([say('partial')], stop)]),
      tools: gateway().g,
      approver: approver(false),
      trace: memoryTrace(),
    });
    expect(r).toMatchObject({ outcome: 'incomplete', reason: stop, text: 'partial' });
  });

  it('truncates a huge tool result before sending it to the model', async () => {
    const model = new FakeModel([reply([toolUse('l', 'list_orders', {})]), reply([say('ok')])]);
    await runAgent('list', {
      model,
      tools: gateway({ list_orders: { text: 'x'.repeat(50_000) } }).g,
      approver: approver(false),
      trace: memoryTrace(),
    });
    const sent = lastUserBlocks(model)[0].content!;
    expect(sent.length).toBeLessThan(20_100);
    expect(sent).toMatch(/truncated/);
  });

  it('ends with outcome error when the tool transport fails', async () => {
    const g: ToolGateway = {
      listTools: async () => SPECS,
      call: async () => {
        throw new Error('MCP connection closed');
      },
    };
    const r = await runAgent('x', {
      model: new FakeModel([reply([toolUse('t', 'list_orders', {})])]),
      tools: g,
      approver: approver(false),
      trace: memoryTrace(),
    });
    expect(r).toMatchObject({ outcome: 'error', reason: expect.stringContaining('MCP connection closed') });
  });
});
