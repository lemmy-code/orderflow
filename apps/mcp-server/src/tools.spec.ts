import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrdersApi, OrdersApiError } from './orders-api';
import { createOrderflowServer } from './tools';

const KB = '11111111-1111-4111-8111-111111111111';
const ORDER = '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e';
const view = (status: string) => ({ id: ORDER, status, totalCents: null, rejectionReason: null });

async function connect(api: Partial<OrdersApi>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createOrderflowServer(api as OrdersApi).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe('orderflow MCP tools', () => {
  it('lists exactly the six tools, each with a description and an input schema', async () => {
    const c = await connect({});
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_order',
      'create_order',
      'get_order',
      'list_orders',
      'list_products',
      'pay_order',
    ]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('list_products returns the seeded catalogue', async () => {
    const r = await (await connect({})).callTool({ name: 'list_products', arguments: {} });
    expect(text(r)).toContain(KB);
  });

  it('create_order passes items through and returns the order', async () => {
    const createOrder = jest.fn().mockResolvedValue(view('PENDING'));
    const r = await (await connect({ createOrder })).callTool({
      name: 'create_order',
      arguments: { items: [{ productId: KB, quantity: 2 }] },
    });
    expect(createOrder).toHaveBeenCalledWith([{ productId: KB, quantity: 2 }]);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ id: ORDER, status: 'PENDING' });
  });

  it('rejects invalid arguments before the API is called', async () => {
    const createOrder = jest.fn();
    const r = await (await connect({ createOrder })).callTool({
      name: 'create_order',
      arguments: { items: [{ productId: 'kb', quantity: 0 }] },
    });
    expect(r.isError).toBe(true);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_STATE', /get_order/],
    ['NOT_FOUND', /list_orders/],
    ['BAD_USER_INPUT', /arguments/],
  ])('turns API error %s into a tool error with a recovery hint', async (code, hint) => {
    const payOrder = jest.fn().mockRejectedValue(new OrdersApiError(code, 'nope'));
    const r = await (await connect({ payOrder })).callTool({ name: 'pay_order', arguments: { orderId: ORDER } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(code);
    expect(text(r)).toMatch(hint);
  });
});
