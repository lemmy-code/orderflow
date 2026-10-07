import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { OrdersAppModule } from '../../apps/orders/src/app.module';
import { startPostgres } from '../support/postgres';

const KEYBOARD = '11111111-1111-4111-8111-111111111111';
type GqlResponse = { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: { code?: string } }[] };

describe('orders GraphQL API (real PostgreSQL, no Kafka)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;

  const gql = async (query: string, variables?: object): Promise<GqlResponse> =>
    (await request(app.getHttpServer()).post('/graphql').send({ query, variables })).body;

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    process.env.ORDERS_DATABASE_URL = started.ordersUrl;
    process.env.ORDERS_MESSAGING = 'off';
    app = await NestFactory.create(OrdersAppModule, { logger: ['error', 'warn'] });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    delete process.env.ORDERS_MESSAGING;
  });

  it('answers the health check', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('creates an order and reads it back', async () => {
    const created = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id status totalCents } }`, {
      items: [{ productId: KEYBOARD, quantity: 2 }],
    });
    expect(created.errors).toBeUndefined();
    const order = created.data?.createOrder as { id: string; status: string; totalCents: number | null };
    expect(order).toMatchObject({ status: 'PENDING', totalCents: null });

    const read = await gql(`query($id: ID!) { order(id: $id) { id status items { productId quantity } } }`, { id: order.id });
    expect(read.data?.order).toMatchObject({ id: order.id, items: [{ productId: KEYBOARD, quantity: 2 }] });
  });

  it.each([
    ['no items', []],
    ['quantity 0', [{ productId: KEYBOARD, quantity: 0 }]],
    ['a non-UUID productId', [{ productId: 'keyboard', quantity: 1 }]],
  ])('returns BAD_USER_INPUT for %s', async (_label, items) => {
    const res = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id } }`, { items });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('returns BAD_USER_INPUT, not a server error, for a non-UUID id', async () => {
    const res = await gql(`query { order(id: "nope") { id } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('returns NOT_FOUND when paying an order that does not exist', async () => {
    const res = await gql(`mutation { payOrder(id: "99999999-9999-4999-8999-999999999999") { id } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_STATE when paying a PENDING order', async () => {
    const created = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id } }`, {
      items: [{ productId: KEYBOARD, quantity: 1 }],
    });
    const id = (created.data?.createOrder as { id: string }).id;
    const res = await gql(`mutation($id: ID!) { payOrder(id: $id) { id } }`, { id });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATE');
  });

  it('lists orders with a page cursor', async () => {
    const res = await gql(`query { orders(first: 1) { nodes { id } endCursor hasNextPage } }`);
    expect(res.data?.orders).toMatchObject({ hasNextPage: true });
  });

  it('returns BAD_USER_INPUT for first: 0', async () => {
    const res = await gql(`query { orders(first: 0) { nodes { id } } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});
