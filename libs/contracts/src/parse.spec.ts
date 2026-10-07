import { ContractError, EventTypes, parseEvent, Topics } from './index';

const env = {
  eventId: '0b8c1f9e-3b7a-4c55-9d0e-1a2b3c4d5e6f',
  occurredAt: '2026-10-07T10:00:00.000Z',
  orderId: '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e',
};
const KEYBOARD = '11111111-1111-4111-8111-111111111111';
const raw = (v: unknown) => JSON.stringify(v);

describe('parseEvent', () => {
  it('accepts a valid order.created on order-events', () => {
    const e = parseEvent(
      Topics.OrderEvents,
      raw({ ...env, type: EventTypes.OrderCreated, items: [{ productId: KEYBOARD, quantity: 2 }] }),
    );
    expect(e).toMatchObject({ type: 'order.created', orderId: env.orderId });
  });

  it('accepts a valid stock.rejected on stock-events', () => {
    const e = parseEvent(Topics.StockEvents, raw({ ...env, type: EventTypes.StockRejected, reason: 'INSUFFICIENT_STOCK' }));
    expect(e.type).toBe('stock.rejected');
  });

  it.each([
    ['null', null],
    ['not JSON', 'not json'],
    ['a JSON array', '[]'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseEvent(Topics.OrderEvents, value)).toThrow(ContractError);
  });

  it('rejects an event on the wrong topic', () => {
    const value = raw({ ...env, type: EventTypes.StockReserved, lines: [] });
    expect(() => parseEvent(Topics.OrderEvents, value)).toThrow(/topic/);
  });

  it('rejects an unknown type', () => {
    expect(() => parseEvent(Topics.OrderEvents, raw({ ...env, type: 'order.exploded' }))).toThrow(ContractError);
  });

  it.each([
    ['empty items', []],
    ['zero quantity', [{ productId: KEYBOARD, quantity: 0 }]],
    ['fractional quantity', [{ productId: KEYBOARD, quantity: 1.5 }]],
    ['non-UUID productId', [{ productId: 'abc', quantity: 1 }]],
  ])('rejects order.created with %s', (_label, items) => {
    expect(() => parseEvent(Topics.OrderEvents, raw({ ...env, type: EventTypes.OrderCreated, items }))).toThrow(ContractError);
  });

  it('rejects a bad envelope', () => {
    const value = raw({ ...env, eventId: 'nope', type: EventTypes.OrderCancelled });
    expect(() => parseEvent(Topics.OrderEvents, value)).toThrow(/eventId/);
  });

  it('rejects an unknown rejection reason', () => {
    const value = raw({ ...env, type: EventTypes.StockRejected, reason: 'BORED' });
    expect(() => parseEvent(Topics.StockEvents, value)).toThrow(/reason/);
  });
});
