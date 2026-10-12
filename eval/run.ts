import { anthropicModel } from '../apps/agent/src/anthropic-model';
import { runAgent } from '../apps/agent/src/loop';
import { connectMcpGateway, stdioServerTransport } from '../apps/agent/src/mcp-gateway';
import { memoryTrace } from '../apps/agent/src/trace';
import { graphqlOrdersApi } from '../apps/mcp-server/src/orders-api';
import { Call, CASES } from './cases';

/** Runs every case against the real model and the running stack; every approval is denied, so nothing is paid or cancelled. */
async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. The eval runs the real model and needs the stack up (docker compose up --wait).');
    process.exit(2);
  }
  const url = process.env.ORDERS_GRAPHQL_URL ?? 'http://localhost:3000/graphql';
  const seed = await graphqlOrdersApi(url).createOrder([{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }]);
  const model = anthropicModel({ model: process.env.AGENT_MODEL ?? 'claude-sonnet-5-5' });
  let failed = 0;
  for (const c of CASES) {
    const tools = await connectMcpGateway(stdioServerTransport({ ...process.env, ORDERS_GRAPHQL_URL: url } as Record<string, string>));
    const trace = memoryTrace();
    const r = await runAgent(c.task({ orderId: seed.id }), { model, tools, trace, approver: { approve: async () => false } });
    await tools.close();
    const calls: Call[] = [];
    for (const e of trace.events) {
      if (e.type === 'tool_request') calls.push({ tool: e.tool, input: (e.input ?? {}) as Record<string, unknown>, decision: 'pending' });
      if (e.type === 'policy' && calls.length) calls[calls.length - 1].decision = e.decision;
    }
    const problem = c.check(calls, r.text);
    if (problem) failed++;
    const path = calls.map((x) => `${x.tool}[${x.decision}]`).join(' → ') || '(no tools)';
    console.log(`${problem ? '✗' : '✓'} ${c.name.padEnd(26)} ${path}${problem ? `  — ${problem}` : ''}`);
    if (c.name === 'over the limit') console.log(`    model said: ${r.text.slice(0, 200)}`);
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
