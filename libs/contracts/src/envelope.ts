import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from './events';

export function newEnvelope(orderId: string): EventEnvelope {
  return { eventId: randomUUID(), occurredAt: new Date().toISOString(), orderId };
}
