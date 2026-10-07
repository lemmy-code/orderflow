import { ContractError } from '@app/contracts';
import { backoffMs, decide, MAX_ATTEMPTS } from './retry';

describe('retry policy', () => {
  it('doubles the backoff each attempt', () => {
    expect([1, 2, 3].map((a) => backoffMs(a, 200))).toEqual([200, 400, 800]);
  });

  it('retries a handler error until the last attempt, then dead-letters', () => {
    expect(decide(new Error('db down'), 1)).toBe('retry');
    expect(decide(new Error('db down'), MAX_ATTEMPTS - 1)).toBe('retry');
    expect(decide(new Error('db down'), MAX_ATTEMPTS)).toBe('dlq');
  });

  it('dead-letters a contract violation on the first attempt (retrying cannot fix it)', () => {
    expect(decide(new ContractError('bad payload'), 1)).toBe('dlq');
  });
});
