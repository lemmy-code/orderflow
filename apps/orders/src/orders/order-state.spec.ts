import { assertTransition, canTransition, InvalidStateError } from './order-state';
import { OrderStatus as S } from './order-status';

describe('order state machine', () => {
  it.each([
    [S.PENDING, S.RESERVED],
    [S.PENDING, S.REJECTED],
    [S.PENDING, S.CANCELLED],
    [S.RESERVED, S.PAID],
    [S.RESERVED, S.CANCELLED],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    [S.PENDING, S.PAID],
    [S.REJECTED, S.PAID],
    [S.REJECTED, S.CANCELLED],
    [S.PAID, S.CANCELLED],
    [S.CANCELLED, S.CANCELLED],
    [S.PAID, S.PAID],
    [S.RESERVED, S.RESERVED],
  ])('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidStateError);
  });
});
