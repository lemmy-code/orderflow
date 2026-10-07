import { isUuid, OrderItemLine } from '@app/contracts';
import { InvalidInputError } from './errors';

export const MAX_LINES = 50;
export const MAX_QUANTITY = 1000;

export function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) throw new InvalidInputError(`${field} must be a UUID`);
}

export function validateItems(items: OrderItemLine[]): void {
  if (items.length === 0) throw new InvalidInputError('An order needs at least one item');
  if (items.length > MAX_LINES) throw new InvalidInputError(`An order can have at most ${MAX_LINES} lines`);
  const seen = new Set<string>();
  for (const item of items) {
    assertUuid(item.productId, 'productId');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      throw new InvalidInputError(`quantity must be an integer from 1 to ${MAX_QUANTITY}`);
    }
    if (seen.has(item.productId)) {
      throw new InvalidInputError(`productId ${item.productId} appears twice; combine the quantities`);
    }
    seen.add(item.productId);
  }
}
