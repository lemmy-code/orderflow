import { dlqTopic, EventTypes, newEnvelope, Topics } from '@app/contracts';
import { createKafka } from '@app/messaging';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kafka, Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { InventoryAppModule } from '../../apps/inventory/src/app.module';
import { SEED_PRODUCTS } from '../../apps/inventory/src/stock/seed';
import { OrdersAppModule } from '../../apps/orders/src/app.module';
import { startKafka } from '../support/kafka';
import { startPostgres } from '../support/postgres';
import { waitFor } from '../support/wait-for';

const [KEYBOARD, MOUSE, MONITOR] = SEED_PRODUCTS.map((p) => p.id);
type Gql = { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: { code?: string } }[] };
type OrderView = { id: string; status: string; totalCents: number | null; rejectionReason: string | null };

describe('orderflow end to end', () => {
  let pg: StartedPostgreSqlContainer;
  let kafkaContainer: StartedKafkaContainer;
  let kafka: Kafka;
  let rawProducer: Producer;
  let orders: INestApplication;
  let inventory: INestApplicationContext;
  let inventoryDb: Client;

  const gql = async (query: string, variables?: object): Promise<Gql> =>
    (await request(orders.getHttpServer()).post('/graphql').send({ query, variables })).body;
  const createOrder = async (items: { productId: string; quantity: number }[]): Promise<string> => {
    const res = await gql(`mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { id } }`, { items });
    expect(res.errors).toBeUndefined();
    return (res.data?.createOrder as { id: string }).id;
  };
  const readOrder = async (id: string): Promise<OrderView> =>
    (await gql(`query($id: ID!) { order(id: $id) { id status totalCents rejectionReason } }`, { id })).data?.order as OrderView;
  const waitForStatus = (id: string, status: string) => waitFor(() => readOrder(id), (o) => o?.status === status);
  const stockOf = async (id: string): Promise<number> =>
    (await inventoryDb.query('SELECT stock_available FROM products WHERE id = $1', [id])).rows[0].stock_available;

  beforeAll(async () => {
    const [p, k] = await Promise.all([startPostgres(), startKafka()]);
    pg = p.container;
    kafkaContainer = k.container;
    // No .env anywhere: everything comes from these variables, read when the modules initialise.
    process.env.ORDERS_DATABASE_URL = p.ordersUrl;
    process.env.INVENTORY_DATABASE_URL = p.inventoryUrl;
    process.env.KAFKA_BROKERS = k.brokers.join(',');
    process.env.OUTBOX_INTERVAL_MS = '100';

    inventory = await NestFactory.createApplicationContext(InventoryAppModule, { logger: ['error', 'warn'] });
    orders = await NestFactory.create(OrdersAppModule, { logger: ['error', 'warn'] });
    await orders.init();

    kafka = createKafka('e2e', k.brokers);
    rawProducer = kafka.producer();
    await rawProducer.connect();
    inventoryDb = new Client({ connectionString: p.inventoryUrl });
    await inventoryDb.connect();
  });

  afterAll(async () => {
    await inventoryDb?.end();
    await rawProducer?.disconnect();
    await orders?.close();
    await inventory?.close();
    await kafkaContainer?.stop();
    await pg?.stop();
  });

  it('1. reserves stock for a new order, then takes payment', async () => {
    const before = await stockOf(KEYBOARD);
    const id = await createOrder([{ productId: KEYBOARD, quantity: 2 }]);
    const reserved = await waitForStatus(id, 'RESERVED');
    expect(reserved.totalCents).toBe(2 * 8999);
    expect(await stockOf(KEYBOARD)).toBe(before - 2);

    const paid = await gql(`mutation($id: ID!) { payOrder(id: $id) { status } }`, { id });
    expect(paid.data?.payOrder).toEqual({ status: 'PAID' });
  });

  let rejectedId = '';
  it('2. rejects an order larger than the stock, leaving stock unchanged', async () => {
    const before = await stockOf(MONITOR);
    rejectedId = await createOrder([{ productId: MONITOR, quantity: before + 1 }]);
    const rejected = await waitForStatus(rejectedId, 'REJECTED');
    expect(rejected.rejectionReason).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(MONITOR)).toBe(before);
  });

  it('3. releases stock when a reserved order is cancelled', async () => {
    const before = await stockOf(MOUSE);
    const id = await createOrder([{ productId: MOUSE, quantity: 2 }]);
    await waitForStatus(id, 'RESERVED');
    expect(await stockOf(MOUSE)).toBe(before - 2);

    await gql(`mutation($id: ID!) { cancelOrder(id: $id) { status } }`, { id });
    await waitFor(() => stockOf(MOUSE), (s) => s === before);
  });

  it('4. reserves stock once when the same order.created is delivered twice', async () => {
    const before = await stockOf(KEYBOARD);
    const id = await createOrder([{ productId: KEYBOARD, quantity: 1 }]);
    await waitForStatus(id, 'RESERVED');

    // Re-deliver the exact event the outbox already sent (same eventId), as Kafka may after a rebalance.
    const ordersDb = new Client({ connectionString: process.env.ORDERS_DATABASE_URL });
    await ordersDb.connect();
    const { rows } = await ordersDb.query(`SELECT payload FROM outbox WHERE key = $1 AND payload->>'type' = 'order.created'`, [id]);
    await ordersDb.end();
    await rawProducer.send({ topic: Topics.OrderEvents, messages: [{ key: id, value: JSON.stringify(rows[0].payload) }] });

    // Then cancel. Same key, same partition, so inventory handles the duplicate before the cancel.
    await gql(`mutation($id: ID!) { cancelOrder(id: $id) { status } }`, { id });
    const released = await waitFor(
      async () => (await inventoryDb.query('SELECT status FROM reservations WHERE order_id = $1', [id])).rows,
      (r) => r.length > 0 && r.every((x: { status: string }) => x.status === 'RELEASED'),
    );
    expect(released).toHaveLength(1); // a second reservation would mean the duplicate was processed
    expect(await stockOf(KEYBOARD)).toBe(before);
  });

  it('5. dead-letters a malformed message and keeps processing the next orders', async () => {
    const poisonKey = randomUUID();
    await rawProducer.send({ topic: Topics.OrderEvents, messages: [{ key: poisonKey, value: 'definitely not json' }] });
    // A well-formed event with a type that does not belong on this topic is a contract violation too.
    await rawProducer.send({
      topic: Topics.OrderEvents,
      messages: [
        {
          key: poisonKey,
          value: JSON.stringify({ ...newEnvelope(poisonKey), type: EventTypes.StockRejected, reason: 'UNKNOWN_PRODUCT' }),
        },
      ],
    });

    const id = await createOrder([{ productId: KEYBOARD, quantity: 1 }]);
    await waitForStatus(id, 'RESERVED');

    const dead: { original: string; attempts: number }[] = [];
    const reader = kafka.consumer({ groupId: `dlq-reader-${randomUUID()}` });
    await reader.connect();
    await reader.subscribe({ topic: dlqTopic(Topics.OrderEvents), fromBeginning: true });
    await reader.run({ eachMessage: async ({ message }) => void dead.push(JSON.parse(String(message.value))) });
    try {
      await waitFor(async () => dead.length, (n) => n >= 2);
    } finally {
      await reader.disconnect();
    }
    expect(dead.map((d) => d.original)).toContain('definitely not json');
    expect(dead.every((d) => d.attempts === 1)).toBe(true);
  });

  it('6. refuses to pay a REJECTED order', async () => {
    const res = await gql(`mutation($id: ID!) { payOrder(id: $id) { status } }`, { id: rejectedId });
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATE');
  });
});
