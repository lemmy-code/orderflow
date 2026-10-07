import { EventTypes, Topics } from '@app/contracts';
import { DeadLetter, processMessage, ProcessDeps } from './consumer';

const valid = JSON.stringify({
  type: EventTypes.OrderCancelled,
  eventId: '0b8c1f9e-3b7a-4c55-9d0e-1a2b3c4d5e6f',
  occurredAt: '2026-10-07T10:00:00.000Z',
  orderId: '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e',
});
const msg = (value: string | null) => ({ topic: Topics.OrderEvents, key: 'k', value });

function deps(handle: ProcessDeps['handle']) {
  const dead: DeadLetter[] = [];
  const sleeps: number[] = [];
  const d: ProcessDeps = {
    handle,
    sendToDlq: async (x) => void dead.push(x),
    sleep: async (ms) => void sleeps.push(ms),
    baseBackoffMs: 200,
  };
  return { d, dead, sleeps };
}

describe('processMessage', () => {
  it('hands a valid event to the handler once', async () => {
    const handle = jest.fn().mockResolvedValue(undefined);
    const { d, dead } = deps(handle);
    await expect(processMessage(msg(valid), d)).resolves.toBe('handled');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(dead).toHaveLength(0);
  });

  it('retries a transient failure with backoff and then succeeds', async () => {
    const handle = jest.fn().mockRejectedValueOnce(new Error('deadlock')).mockResolvedValue(undefined);
    const { d, dead, sleeps } = deps(handle);
    await expect(processMessage(msg(valid), d)).resolves.toBe('handled');
    expect(handle).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([200]);
    expect(dead).toHaveLength(0);
  });

  it('dead-letters after 3 failed attempts, keeping the original and the error', async () => {
    const handle = jest.fn().mockRejectedValue(new Error('always broken'));
    const { d, dead, sleeps } = deps(handle);
    await expect(processMessage(msg(valid), d)).resolves.toBe('dead-lettered');
    expect(handle).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 400]);
    expect(dead[0]).toMatchObject({ topic: 'order-events', key: 'k', original: valid, error: 'always broken', attempts: 3 });
  });

  it('dead-letters a malformed message immediately without calling the handler', async () => {
    const handle = jest.fn();
    const { d, dead, sleeps } = deps(handle);
    await expect(processMessage(msg('not json'), d)).resolves.toBe('dead-lettered');
    expect(handle).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
    expect(dead[0]).toMatchObject({ original: 'not json', attempts: 1 });
  });
});
