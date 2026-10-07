import { InvalidInputError } from './errors';
import { decodeCursor, encodeCursor, MAX_PAGE_SIZE, pageSize } from './pagination';

describe('pagination', () => {
  it('defaults to 20 and caps at 100', () => {
    expect(pageSize(undefined)).toBe(20);
    expect(pageSize(null)).toBe(20);
    expect(pageSize(5)).toBe(5);
    expect(pageSize(1000)).toBe(MAX_PAGE_SIZE);
  });

  it('rejects a page size below 1', () => {
    expect(() => pageSize(0)).toThrow(InvalidInputError);
  });

  it('round-trips a cursor', () => {
    const c = encodeCursor({ createdAt: new Date('2026-10-07T10:00:00.123Z'), id: '11111111-1111-4111-8111-111111111111' });
    expect(decodeCursor(c)).toEqual({ createdAt: '2026-10-07T10:00:00.123Z', id: '11111111-1111-4111-8111-111111111111' });
  });

  it.each([
    'garbage',
    Buffer.from('no-separator').toString('base64url'),
    Buffer.from('not-a-date|abc').toString('base64url'),
  ])('rejects a malformed cursor %s', (c) => {
    expect(() => decodeCursor(c)).toThrow(InvalidInputError);
  });
});
