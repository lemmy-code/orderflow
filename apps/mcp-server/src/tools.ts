import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SEED_PRODUCTS } from '../../inventory/src/stock/seed';
import { OrdersApi, OrdersApiError } from './orders-api';

const orderId = z.uuid().describe('The order id, exactly as returned by create_order or list_orders.');

/** What the model should do next for each API error code: the difference between an agent that recovers and one that gives up. */
const HINTS: Record<string, string> = {
  BAD_USER_INPUT: 'Fix the arguments and try again.',
  NOT_FOUND: 'Check the id; use list_orders to find existing orders.',
  INVALID_STATE: 'Call get_order to see the current status. A PENDING order cannot be paid until it is RESERVED.',
};

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
  } catch (e) {
    const code = e instanceof OrdersApiError ? e.code : 'INTERNAL';
    const msg = e instanceof Error ? e.message : String(e);
    const hint = HINTS[code] ?? 'The orders service failed; you may retry once.';
    return { isError: true, content: [{ type: 'text', text: `${code}: ${msg}. ${hint}` }] };
  }
}

export function registerOrderflowTools(server: McpServer, api: OrdersApi): void {
  server.registerTool(
    'list_products',
    {
      description:
        'List the products that can be ordered, with their ids, names and prices in cents. Call this first whenever the user names a product, to get its productId; never guess ids.',
      inputSchema: {},
    },
    () => run(async () => SEED_PRODUCTS.map(({ id, sku, name, priceCents }) => ({ id, sku, name, priceCents }))),
  );

  server.registerTool(
    'create_order',
    {
      description:
        'Create an order for one or more products. Returns the order with status PENDING: inventory reserves stock asynchronously within a few seconds, after which the status becomes RESERVED (with a total) or REJECTED (with a reason). Each product may appear only once.',
      inputSchema: {
        items: z
          .array(
            z.object({
              productId: z.uuid().describe('An id from list_products.'),
              quantity: z.int().min(1).max(1000),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    ({ items }) => run(() => api.createOrder(items)),
  );

  server.registerTool(
    'get_order',
    {
      description:
        'Get one order: status (PENDING, RESERVED, REJECTED, PAID or CANCELLED), total in cents, rejection reason and items. Use it to check whether a new order has been RESERVED before paying.',
      inputSchema: { orderId },
    },
    ({ orderId: id }) => run(() => api.getOrder(id)),
  );

  server.registerTool(
    'list_orders',
    {
      description:
        'List existing orders, newest first, optionally filtered by status. Use it to find an order the user refers to, e.g. "my last order" is the first result.',
      inputSchema: {
        status: z.enum(['PENDING', 'RESERVED', 'REJECTED', 'PAID', 'CANCELLED']).optional(),
        first: z.int().min(1).max(100).optional().describe('How many orders to return, default 20.'),
      },
    },
    ({ status, first }) => run(() => api.listOrders({ status, first })),
  );

  server.registerTool(
    'pay_order',
    {
      description:
        'Pay for an order (simulated payment). Only a RESERVED order can be paid; check with get_order first. Requires human approval.',
      inputSchema: { orderId },
    },
    ({ orderId: id }) => run(() => api.payOrder(id)),
  );

  server.registerTool(
    'cancel_order',
    {
      description:
        'Cancel an order that is PENDING or RESERVED; reserved stock is released. Paid and rejected orders cannot be cancelled. Requires human approval.',
      inputSchema: { orderId },
    },
    ({ orderId: id }) => run(() => api.cancelOrder(id)),
  );
}

export function createOrderflowServer(api: OrdersApi): McpServer {
  const server = new McpServer({ name: 'orderflow', version: '0.1.0' });
  registerOrderflowTools(server, api);
  return server;
}
