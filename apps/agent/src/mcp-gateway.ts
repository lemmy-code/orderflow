import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolve } from 'node:path';
import { ToolGateway } from './types';

/** The agent's side of MCP: list the server's tools and call them. Any transport works (stdio, in-memory, HTTP). */
export async function connectMcpGateway(transport: Transport): Promise<ToolGateway & { close(): Promise<void> }> {
  const client = new Client({ name: 'orderflow-agent', version: '0.1.0' });
  await client.connect(transport);
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    },
    async call(name, args) {
      const r = (await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (r.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return { text, isError: r.isError === true };
    },
    close: () => client.close(),
  };
}

/** Spawns the MCP server as a child process; the two talk over its stdin and stdout. */
export function stdioServerTransport(env: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve(__dirname, '../../mcp-server/src/main.ts')],
    env,
  });
}
