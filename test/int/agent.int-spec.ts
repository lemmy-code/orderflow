import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runAgent } from '../../apps/agent/src/loop';
import { connectMcpGateway } from '../../apps/agent/src/mcp-gateway';
import { memoryTrace } from '../../apps/agent/src/trace';
import { ModelClient, ModelRequest } from '../../apps/agent/src/types';
import { graphqlOrdersApi } from '../../apps/mcp-server/src/orders-api';
import { createOrderflowServer } from '../../apps/mcp-server/src/tools';
import { reply, say, toolUse } from '../support/fake-model';
import { startOrdersHttp } from '../support/orders-http';
import { startPostgres } from '../support/postgres';

const KB = '11111111-1111-4111-8111-111111111111';

describe('agent end to end (scripted model, real MCP server, real orders API)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let graphqlUrl: string;

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ({ app, graphqlUrl } = await startOrdersHttp(started.ordersUrl));
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    delete process.env.ORDERS_MESSAGING;
  });

  it('looks up the product, creates the order, and stops at a denied payment', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createOrderflowServer(graphqlOrdersApi(graphqlUrl)).connect(a);
    const tools = await connectMcpGateway(b);

    // A scripted "model" that reads the real order id the server returned before deciding to pay it.
    let orderId = '';
    const model: ModelClient = {
      async create(r: ModelRequest) {
        const calls = r.messages.filter((m) => m.role === 'assistant').length;
        if (calls === 0) return reply([toolUse('1', 'list_products', {})]);
        if (calls === 1) return reply([toolUse('2', 'create_order', { items: [{ productId: KB, quantity: 2 }] })]);
        if (calls === 2) {
          const results = r.messages.at(-1)!.content as { content: string }[];
          orderId = JSON.parse(results[0].content).id;
          return reply([toolUse('3', 'pay_order', { orderId })]);
        }
        return reply([say('The order is created but payment was not approved.')]);
      },
    };
    const asked: string[] = [];
    const trace = memoryTrace();
    const r = await runAgent('order 2 keyboards and pay', {
      model,
      tools,
      trace,
      approver: {
        approve: async ({ tool }) => {
          asked.push(tool);
          return false;
        },
      },
    });
    await tools.close();

    expect(r.outcome).toBe('done');
    expect(asked).toEqual(['pay_order']);
    expect(trace.events.filter((e) => e.type === 'tool_result').map((e) => (e as { tool: string }).tool)).toEqual([
      'list_products',
      'create_order',
    ]);
    const order = await graphqlOrdersApi(graphqlUrl).getOrder(orderId);
    expect(order).toMatchObject({ status: 'PENDING', items: [{ productId: KB, quantity: 2 }] });
  });
});
