import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { graphqlOrdersApi } from '../../apps/mcp-server/src/orders-api';
import { createOrderflowServer } from '../../apps/mcp-server/src/tools';
import { startOrdersHttp } from '../support/orders-http';
import { startPostgres } from '../support/postgres';

const KB = '11111111-1111-4111-8111-111111111111';
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe('orderflow MCP server (real orders API)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let client: Client;

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    const orders = await startOrdersHttp(started.ordersUrl);
    app = orders.app;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createOrderflowServer(graphqlOrdersApi(orders.graphqlUrl)).connect(a);
    client = new Client({ name: 'int', version: '1' });
    await client.connect(b);
  });
  afterAll(async () => {
    await client?.close();
    await app?.close();
    await pg?.stop();
    delete process.env.ORDERS_MESSAGING;
  });

  it('creates an order and reads it back through the tools', async () => {
    const created = JSON.parse(
      text(await client.callTool({ name: 'create_order', arguments: { items: [{ productId: KB, quantity: 2 }] } })),
    );
    expect(created.status).toBe('PENDING');
    const read = JSON.parse(text(await client.callTool({ name: 'get_order', arguments: { orderId: created.id } })));
    expect(read).toMatchObject({ id: created.id, items: [{ productId: KB, quantity: 2 }] });
  });

  it('maps INVALID_STATE (paying a PENDING order) to a tool error with a hint', async () => {
    const created = JSON.parse(
      text(await client.callTool({ name: 'create_order', arguments: { items: [{ productId: KB, quantity: 1 }] } })),
    );
    const r = await client.callTool({ name: 'pay_order', arguments: { orderId: created.id } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^INVALID_STATE: .*get_order/);
  });

  it('maps an unknown order to NOT_FOUND', async () => {
    const r = await client.callTool({ name: 'get_order', arguments: { orderId: '99999999-9999-4999-8999-999999999999' } });
    expect(text(r)).toMatch(/^NOT_FOUND/);
  });

  it('lists orders filtered by status', async () => {
    const r = JSON.parse(text(await client.callTool({ name: 'list_orders', arguments: { status: 'PENDING' } })));
    expect(r.length).toBeGreaterThanOrEqual(2);
  });
});
