import { aggregate, decideReservation, StockRow } from './stock';

const K = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const stock = (rows: StockRow[]) => new Map(rows.map((r) => [r.id, r]));
const shelf = stock([
  { id: K, stockAvailable: 10, priceCents: 8999 },
  { id: M, stockAvailable: 1, priceCents: 2999 },
]);

describe('aggregate', () => {
  it('sums the same product appearing twice and sorts by id', () => {
    expect(aggregate([{ productId: M, quantity: 1 }, { productId: K, quantity: 2 }, { productId: K, quantity: 3 }])).toEqual([
      { productId: K, quantity: 5 },
      { productId: M, quantity: 1 },
    ]);
  });
});

describe('decideReservation', () => {
  it('reserves when every line fits, returning unit prices', () => {
    expect(decideReservation([{ productId: K, quantity: 10 }], shelf)).toEqual({
      ok: true,
      lines: [{ productId: K, unitPriceCents: 8999 }],
    });
  });

  it('rejects with INSUFFICIENT_STOCK when any line exceeds stock', () => {
    expect(decideReservation([{ productId: K, quantity: 1 }, { productId: M, quantity: 2 }], shelf)).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_STOCK',
    });
  });

  it('rejects with UNKNOWN_PRODUCT before checking quantities', () => {
    expect(decideReservation([{ productId: '99999999-9999-4999-8999-999999999999', quantity: 1 }], shelf)).toEqual({
      ok: false,
      reason: 'UNKNOWN_PRODUCT',
    });
  });

  it('judges duplicates by their combined quantity', () => {
    expect(decideReservation(aggregate([{ productId: M, quantity: 1 }, { productId: M, quantity: 1 }]), shelf)).toMatchObject({
      ok: false,
      reason: 'INSUFFICIENT_STOCK',
    });
  });
});
