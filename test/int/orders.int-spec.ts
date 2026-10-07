import { EventTypes, newEnvelope, StockRejected, StockReserved } from '@app/contracts';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ordersDataSourceOptions } from '../../apps/orders/src/data-source';
import { InvalidInputError, OrderNotFoundError } from '../../apps/orders/src/orders/errors';
import { InvalidStateError } from '../../apps/orders/src/orders/order-state';
import { OrderStatus } from '../../apps/orders/src/orders/order-status';
import { OrdersService } from '../../apps/orders/src/orders/orders.service';
import { startPostgres } from '../support/postgres';

const KEYBOARD = '11111111-1111-4111-8111-111111111111';
const MOUSE = '22222222-2222-4222-8222-222222222222';
const MISSING = '99999999-9999-4999-8999-999999999999';

describe('OrdersService (real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let orders: OrdersService;

  const outboxTypes = async (orderId: string) =>
    (await ds.query(`SELECT payload->>'type' AS type FROM outbox WHERE key = $1 ORDER BY seq`, [orderId])).map(
      (r: { type: string }) => r.type,
    );
  const reserved = (orderId: string): StockReserved => ({
    ...newEnvelope(orderId),
    type: EventTypes.StockReserved,
    lines: [
      { productId: KEYBOARD, unitPriceCents: 8999 },
      { productId: MOUSE, unitPriceCents: 2999 },
    ],
  });

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ds = await new DataSource(ordersDataSourceOptions(started.ordersUrl)).initialize();
    orders = new OrdersService(ds);
  });
  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });
  beforeEach(() => ds.query('TRUNCATE orders, order_items, outbox, processed_events CASCADE'));

  it('creates a PENDING order and its order.created outbox row together', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 2 }]);
    expect(o.status).toBe(OrderStatus.PENDING);
    expect(o.items).toHaveLength(1);
    expect(await outboxTypes(o.id)).toEqual(['order.created']);
  });

  it('saves nothing when the outbox write fails (both or neither)', async () => {
    await ds.query('ALTER TABLE outbox ADD CONSTRAINT always_fail CHECK (false) NOT VALID');
    try {
      await expect(orders.create([{ productId: KEYBOARD, quantity: 1 }])).rejects.toThrow();
      const [{ count }] = await ds.query('SELECT count(*)::int AS count FROM orders');
      expect(count).toBe(0);
    } finally {
      await ds.query('ALTER TABLE outbox DROP CONSTRAINT always_fail');
    }
  });

  it('rejects invalid input before touching the database', async () => {
    await expect(orders.create([])).rejects.toThrow(InvalidInputError);
  });

  it('applies stock.reserved: RESERVED, prices filled in, total computed', async () => {
    const o = await orders.create([
      { productId: KEYBOARD, quantity: 2 },
      { productId: MOUSE, quantity: 1 },
    ]);
    await orders.applyStockReply(reserved(o.id));
    const after = await orders.findById(o.id);
    expect(after).toMatchObject({ status: OrderStatus.RESERVED, totalCents: 2 * 8999 + 2999 });
    expect(after?.items.map((i) => i.unitPriceCents).sort()).toEqual([2999, 8999]);
  });

  it('applies stock.rejected with its reason', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    const rejected: StockRejected = { ...newEnvelope(o.id), type: EventTypes.StockRejected, reason: 'INSUFFICIENT_STOCK' };
    await orders.applyStockReply(rejected);
    expect(await orders.findById(o.id)).toMatchObject({ status: OrderStatus.REJECTED, rejectionReason: 'INSUFFICIENT_STOCK' });
  });

  it('ignores a duplicate stock reply', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    const reply = reserved(o.id);
    await orders.applyStockReply(reply);
    await orders.pay(o.id);
    await orders.applyStockReply(reply); // redelivered after the order moved on
    expect((await orders.findById(o.id))?.status).toBe(OrderStatus.PAID);
  });

  it('ignores a stock reply for an order cancelled in the meantime', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await orders.cancel(o.id);
    await orders.applyStockReply(reserved(o.id));
    expect((await orders.findById(o.id))?.status).toBe(OrderStatus.CANCELLED);
  });

  it('pays a RESERVED order and emits order.paid with the total', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await orders.applyStockReply(reserved(o.id));
    await expect(orders.pay(o.id)).resolves.toMatchObject({ status: OrderStatus.PAID });
    const [paid] = await ds.query(`SELECT payload FROM outbox WHERE key = $1 AND payload->>'type' = 'order.paid'`, [o.id]);
    expect(paid.payload.totalCents).toBe(8999);
  });

  it('refuses to pay a PENDING order', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await expect(orders.pay(o.id)).rejects.toThrow(InvalidStateError);
    expect(await outboxTypes(o.id)).toEqual(['order.created']);
  });

  it('cancels and emits order.cancelled; a second cancel is INVALID_STATE', async () => {
    const o = await orders.create([{ productId: KEYBOARD, quantity: 1 }]);
    await expect(orders.cancel(o.id)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    await expect(orders.cancel(o.id)).rejects.toThrow(InvalidStateError);
    expect(await outboxTypes(o.id)).toEqual(['order.created', 'order.cancelled']);
  });

  it('NOT_FOUND for an unknown id, BAD_USER_INPUT for a non-UUID id', async () => {
    await expect(orders.pay(MISSING)).rejects.toThrow(OrderNotFoundError);
    await expect(orders.cancel('not-a-uuid')).rejects.toThrow(InvalidInputError);
    await expect(orders.findById('not-a-uuid')).rejects.toThrow(InvalidInputError);
    await expect(orders.findById(MISSING)).resolves.toBeNull();
  });

  it('pages through orders with a cursor, filters by status and caps first', async () => {
    const created = [];
    for (let i = 0; i < 3; i++) created.push(await orders.create([{ productId: KEYBOARD, quantity: 1 }]));
    await orders.cancel(created[2].id);

    const page1 = await orders.list({ first: 2 });
    expect(page1.nodes.map((n) => n.id)).toEqual([created[0].id, created[1].id]);
    expect(page1.hasNextPage).toBe(true);
    const page2 = await orders.list({ first: 2, after: page1.endCursor });
    expect(page2.nodes.map((n) => n.id)).toEqual([created[2].id]);
    expect(page2.hasNextPage).toBe(false);

    expect((await orders.list({ status: OrderStatus.CANCELLED })).nodes).toHaveLength(1);
    expect((await orders.list({ first: 1000 })).nodes).toHaveLength(3);
    await expect(orders.list({ after: 'garbage' })).rejects.toThrow(InvalidInputError);
  });
});
