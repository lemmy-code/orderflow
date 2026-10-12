import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { graphqlOrdersApi } from './orders-api';
import { createOrderflowServer } from './tools';

async function main(): Promise<void> {
  // stdout belongs to the MCP protocol: diagnostics go to stderr only.
  const url = process.env.ORDERS_GRAPHQL_URL ?? 'http://localhost:3000/graphql';
  await createOrderflowServer(graphqlOrdersApi(url)).connect(new StdioServerTransport());
  console.error(`orderflow-mcp ready (orders API: ${url})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
