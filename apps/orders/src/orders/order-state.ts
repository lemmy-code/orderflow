import { OrderStatus as S } from './order-status';

const ALLOWED: Record<S, readonly S[]> = {
  [S.PENDING]: [S.RESERVED, S.REJECTED, S.CANCELLED],
  [S.RESERVED]: [S.PAID, S.CANCELLED],
  [S.REJECTED]: [],
  [S.PAID]: [],
  [S.CANCELLED]: [],
};

export class InvalidStateError extends Error {
  constructor(
    readonly from: S,
    readonly to: S,
  ) {
    super(`Cannot move an order from ${from} to ${to}`);
  }
}

export const canTransition = (from: S, to: S): boolean => ALLOWED[from].includes(to);

export function assertTransition(from: S, to: S): void {
  if (!canTransition(from, to)) throw new InvalidStateError(from, to);
}
