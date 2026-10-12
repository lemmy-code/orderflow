import { estimateCostUsd } from '@app/agent-policy';
import { anthropicModel } from './anthropic-model';
import { cliApprover } from './approver';
import { runAgent } from './loop';
import { connectMcpGateway, mcpServerEnv, stdioServerTransport } from './mcp-gateway';
import { jsonlTrace } from './trace';

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env: use the environment as it is
  }
  const args = process.argv.slice(2);
  const echo = args.includes('--trace');
  const task = args
    .filter((a) => a !== '--trace')
    .join(' ')
    .trim();
  if (!task) {
    console.error('usage: npm run agent -- [--trace] "order 2 keyboards and pay for it"');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (put it in .env).');
    process.exit(2);
  }
  const env = mcpServerEnv(process.env, process.env.ORDERS_GRAPHQL_URL ?? 'http://localhost:3000/graphql');
  const tools = await connectMcpGateway(stdioServerTransport(env));
  const trace = jsonlTrace('.agent-traces', echo);
  try {
    const r = await runAgent(task, {
      model: anthropicModel({ model: process.env.AGENT_MODEL ?? 'claude-sonnet-5-5' }),
      tools,
      approver: cliApprover(),
      trace,
    });
    console.log(`\n${r.text}\n`);
    console.log(
      `outcome: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} · steps ${r.steps} · tokens ${r.usage.inputTokens}+${r.usage.outputTokens} · ~$${estimateCostUsd(r.usage).toFixed(4)} · trace ${trace.path}`,
    );
  } finally {
    await tools.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
