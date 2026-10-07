import { InvalidInputError } from './errors';
import { MAX_LINES, validateItems } from './order-input';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

describe('validateItems', () => {
  it('accepts a normal order', () => {
    expect(() => validateItems([{ productId: P1, quantity: 2 }, { productId: P2, quantity: 1 }])).not.toThrow();
  });

  it.each([
    ['no items', []],
    ['quantity 0', [{ productId: P1, quantity: 0 }]],
    ['negative quantity', [{ productId: P1, quantity: -1 }]],
    ['quantity over 1000', [{ productId: P1, quantity: 1001 }]],
    ['fractional quantity', [{ productId: P1, quantity: 1.5 }]],
    ['a non-UUID productId', [{ productId: 'keyboard', quantity: 1 }]],
    ['the same product twice', [{ productId: P1, quantity: 1 }, { productId: P1, quantity: 2 }]],
    [
      'too many lines',
      Array.from({ length: MAX_LINES + 1 }, (_, i) => ({
        productId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        quantity: 1,
      })),
    ],
  ])('rejects %s', (_label, items) => {
    expect(() => validateItems(items)).toThrow(InvalidInputError);
  });
});
