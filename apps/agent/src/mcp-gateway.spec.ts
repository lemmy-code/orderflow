import { mcpServerEnv } from './mcp-gateway';

describe('mcpServerEnv', () => {
  it('gives the MCP server only what it needs: never the Anthropic API key', () => {
    const env = mcpServerEnv({ PATH: '/bin', HOME: '/home/d', ANTHROPIC_API_KEY: 'sk-ant-secret', OTHER: 'x' }, 'http://o/graphql');
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/d', ORDERS_GRAPHQL_URL: 'http://o/graphql' });
  });
});
