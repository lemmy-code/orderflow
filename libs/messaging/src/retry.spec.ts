import { ContractError } from '@app/contracts';
import { backoffMs, decide, MAX_ATTEMPTS, MAX_BACKOFF_MS } from './retry';

describe('retry policy', () => {
  it('doubles the backoff each attempt, capped at 30 s', () => {
    expect([1, 2, 3].map((a) => backoffMs(a, 200))).toEqual([200, 400, 800]);
    expect(backoffMs(20, 200)).toBe(MAX_BACKOFF_MS);
  });

  it('keeps retrying a valid event for over a minute, so a database restart does not dead-letter it', () => {
    let waited = 0;
    for (let attempt = 1; decide(new Error('connection terminated'), attempt) === 'retry'; attempt++) {
      waited += backoffMs(attempt, 200);
    }
    expect(waited).toBeGreaterThan(60_000);
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
