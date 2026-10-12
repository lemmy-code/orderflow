import { query } from '@anthropic-ai/claude-agent-sdk';
import { decide, DEFAULT_LIMITS, TOOL_TIERS } from '@app/agent-policy';
import { resolve } from 'node:path';
import { cliApprover } from '../../agent/src/approver';
import { SYSTEM_PROMPT } from '../../agent/src/prompt';

/** The Agent SDK names MCP tools "mcp__<server>__<tool>"; our policy speaks plain tool names. */
const PREFIX = 'mcp__orderflow__';

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env: use the environment as it is
  }
  const task = process.argv.slice(2).join(' ').trim();
  if (!task || !process.env.ANTHROPIC_API_KEY) {
    console.error('usage: ANTHROPIC_API_KEY=… npm run agent:sdk -- "order 2 keyboards"');
    process.exit(2);
  }
  const exposed = new Set(Object.keys(TOOL_TIERS));
  const approver = cliApprover();

  const q = query({
    prompt: task,
    options: {
      model: process.env.AGENT_MODEL ?? 'claude-sonnet-5-5',
      systemPrompt: SYSTEM_PROMPT,
      tools: [], // no built-in tools (no shell, no files): only our MCP server
      settingSources: [], // ignore ~/.claude settings and their permission rules
      maxTurns: DEFAULT_LIMITS.maxSteps,
      mcpServers: {
        orderflow: {
          command: process.execPath,
          args: ['--import', 'tsx', resolve(__dirname, '../../mcp-server/src/main.ts')],
          env: {
            ...process.env,
            ORDERS_GRAPHQL_URL: process.env.ORDERS_GRAPHQL_URL ?? 'http://localhost:3000/graphql',
          } as Record<string, string>,
        },
      },
      // Same tiers as the hand-written agent, enforced through the framework's permission hook.
      canUseTool: async (name, input) => {
        const tool = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
        const d = decide(tool, exposed);
        if (d.kind === 'allow') return { behavior: 'allow', updatedInput: input };
        if (d.kind === 'ask' && (await approver.approve({ tool, input, reason: d.reason }))) {
          return { behavior: 'allow', updatedInput: input };
        }
        return {
          behavior: 'deny',
          message: d.kind === 'deny' ? d.reason : 'The user denied this action. Do not retry it another way.',
        };
      },
    },
  });

  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text') console.log(b.text);
        if (b.type === 'tool_use') console.error(`· tool ${b.name} ${JSON.stringify(b.input)}`);
      }
    }
    if (m.type === 'result') {
      console.log(`\noutcome: ${m.subtype} · turns ${m.num_turns} · $${m.total_cost_usd.toFixed(4)}`);
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
