import { isUuid } from '@app/contracts';
import { InvalidInputError } from './errors';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface Cursor {
  createdAt: string;
  id: string;
}

export function pageSize(first?: number | null): number {
  if (first === undefined || first === null) return DEFAULT_PAGE_SIZE;
  if (first < 1) throw new InvalidInputError('first must be at least 1');
  return Math.min(first, MAX_PAGE_SIZE);
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !createdAt || Number.isNaN(Date.parse(createdAt)) || !isUuid(id)) {
    throw new InvalidInputError('after is not a valid cursor');
  }
  return { createdAt, id };
}
