import { EventTypes, Topics } from '@app/contracts';
import { planRedrive } from './redrive';

const cancelled = JSON.stringify({
  type: EventTypes.OrderCancelled,
  eventId: '0b8c1f9e-3b7a-4c55-9d0e-1a2b3c4d5e6f',
  occurredAt: '2026-10-07T10:00:00.000Z',
  orderId: '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e',
});
const letter = (original: string | null) => ({
  topic: Topics.OrderEvents,
  key: 'order-1',
  original,
  error: 'connection terminated',
  attempts: 10,
  failedAt: '2026-10-07T10:01:00.000Z',
});

describe('planRedrive', () => {
  it('replays a valid event that was dead-lettered by an infrastructure failure, with its key', () => {
    expect(planRedrive(letter(cancelled))).toEqual({ key: 'order-1', value: cancelled });
  });

  it.each([
    ['a contract violation (replaying would only dead-letter it again)', letter('not json')],
    ['an empty original', letter(null)],
    ['something that is not a dead letter', { hello: 'world' }],
  ])('skips %s', (_label, value) => {
    expect(planRedrive(value)).toBeNull();
  });
});
