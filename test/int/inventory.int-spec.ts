import { EventTypes, newEnvelope, OrderCancelled, OrderCreated, OrderItemLine } from '@app/contracts';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { inventoryDataSourceOptions } from '../../apps/inventory/src/data-source';
import { ReservationService } from '../../apps/inventory/src/stock/reservation.service';
import { SEED_PRODUCTS } from '../../apps/inventory/src/stock/seed';
import { startPostgres } from '../support/postgres';

const [KEYBOARD, MOUSE, MONITOR] = SEED_PRODUCTS.map((p) => p.id);
const created = (items: OrderItemLine[], orderId = randomUUID()): OrderCreated => ({
  ...newEnvelope(orderId),
  type: EventTypes.OrderCreated,
  items,
});
const cancelled = (orderId: string): OrderCancelled => ({ ...newEnvelope(orderId), type: EventTypes.OrderCancelled });

describe('ReservationService (real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let service: ReservationService;

  const stockOf = async (id: string): Promise<number> =>
    (await ds.query('SELECT stock_available FROM products WHERE id = $1', [id]))[0].stock_available;
  const replies = async (orderId: string) =>
    (await ds.query(`SELECT payload FROM outbox WHERE key = $1 ORDER BY seq`, [orderId])).map((r: { payload: unknown }) => r.payload);
  const reservationRows = async (orderId: string) =>
    ds.query('SELECT product_id, quantity, status FROM reservations WHERE order_id = $1 ORDER BY product_id', [orderId]);

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ds = await new DataSource(inventoryDataSourceOptions(started.inventoryUrl)).initialize();
    service = new ReservationService(ds);
  });
  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE reservations, outbox, processed_events');
    for (const p of SEED_PRODUCTS) await ds.query('UPDATE products SET stock_available = $2 WHERE id = $1', [p.id, p.stock]);
  });

  it('reserves stock and writes stock.reserved with unit prices to its outbox', async () => {
    const e = created([{ productId: KEYBOARD, quantity: 3 }]);
    await service.handle(e);
    expect(await stockOf(KEYBOARD)).toBe(7);
    expect(await replies(e.orderId)).toEqual([
      expect.objectContaining({ type: 'stock.reserved', lines: [{ productId: KEYBOARD, unitPriceCents: 8999 }] }),
    ]);
  });

  it('rejects INSUFFICIENT_STOCK and leaves every product untouched', async () => {
    const e = created([{ productId: KEYBOARD, quantity: 1 }, { productId: MONITOR, quantity: 2 }]);
    await service.handle(e);
    expect(await stockOf(KEYBOARD)).toBe(10);
    expect(await stockOf(MONITOR)).toBe(1);
    expect(await replies(e.orderId)).toEqual([expect.objectContaining({ type: 'stock.rejected', reason: 'INSUFFICIENT_STOCK' })]);
  });

  it('rejects UNKNOWN_PRODUCT', async () => {
    const e = created([{ productId: '99999999-9999-4999-8999-999999999999', quantity: 1 }]);
    await service.handle(e);
    expect(await replies(e.orderId)).toEqual([expect.objectContaining({ type: 'stock.rejected', reason: 'UNKNOWN_PRODUCT' })]);
  });

  it('processes a redelivered event once', async () => {
    const e = created([{ productId: MOUSE, quantity: 2 }]);
    await service.handle(e);
    await service.handle(e);
    expect(await stockOf(MOUSE)).toBe(3);
    expect(await replies(e.orderId)).toHaveLength(1);
  });

  it('sums a product that appears twice in one event into one reservation', async () => {
    const e = created([{ productId: MOUSE, quantity: 1 }, { productId: MOUSE, quantity: 2 }]);
    await service.handle(e);
    expect(await stockOf(MOUSE)).toBe(2);
    expect(await reservationRows(e.orderId)).toEqual([{ product_id: MOUSE, quantity: 3, status: 'ACTIVE' }]);
  });

  it('never oversells: two concurrent orders for the last monitor, exactly one wins', async () => {
    const a = created([{ productId: MONITOR, quantity: 1 }]);
    const b = created([{ productId: MONITOR, quantity: 1 }]);
    await Promise.all([service.handle(a), service.handle(b)]);
    expect(await stockOf(MONITOR)).toBe(0);
    const types = [...(await replies(a.orderId)), ...(await replies(b.orderId))].map((r: { type: string }) => r.type).sort();
    expect(types).toEqual(['stock.rejected', 'stock.reserved']);
  });

  it('releases on order.cancelled, once, even if redelivered', async () => {
    const e = created([{ productId: KEYBOARD, quantity: 4 }]);
    await service.handle(e);
    const c = cancelled(e.orderId);
    await service.handle(c);
    await service.handle(c);
    expect(await stockOf(KEYBOARD)).toBe(10);
    expect(await reservationRows(e.orderId)).toEqual([{ product_id: KEYBOARD, quantity: 4, status: 'RELEASED' }]);
  });

  it('treats a cancel for an order it never reserved as a no-op', async () => {
    await expect(service.handle(cancelled(randomUUID()))).resolves.toBeUndefined();
  });
});
