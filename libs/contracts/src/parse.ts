import { AnyEvent, REJECTION_REASONS } from './events';
import { EventType, EventTypes, topicFor } from './topics';

export class ContractError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const KNOWN_TYPES = new Set<string>(Object.values(EventTypes));

function uuidField(o: Obj, field: string): void {
  if (!isUuid(o[field])) throw new ContractError(`${field} must be a UUID`);
}
function intField(o: Obj, field: string, min: number): void {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ContractError(`${field} must be an integer >= ${min}`);
  }
}
function lines(v: unknown, field: string, check: (line: Obj) => void): void {
  if (!Array.isArray(v) || v.length === 0) throw new ContractError(`${field} must be a non-empty array`);
  for (const line of v) {
    if (!isObj(line)) throw new ContractError(`${field} entries must be objects`);
    check(line);
  }
}

/** Validates a raw Kafka message value against the contract for the topic it arrived on. */
export function parseEvent(topic: string, raw: string | null): AnyEvent {
  if (raw === null) throw new ContractError('empty message');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ContractError('message is not JSON');
  }
  if (!isObj(v)) throw new ContractError('message is not a JSON object');
  if (typeof v.type !== 'string' || !KNOWN_TYPES.has(v.type)) throw new ContractError(`unknown type ${String(v.type)}`);
  const type = v.type as EventType;
  if (topicFor(type) !== topic) throw new ContractError(`type ${type} does not belong on topic ${topic}`);
  uuidField(v, 'eventId');
  uuidField(v, 'orderId');
  if (typeof v.occurredAt !== 'string' || Number.isNaN(Date.parse(v.occurredAt))) {
    throw new ContractError('occurredAt must be an ISO date');
  }

  switch (type) {
    case EventTypes.OrderCreated:
      lines(v.items, 'items', (l) => {
        uuidField(l, 'productId');
        intField(l, 'quantity', 1);
      });
      break;
    case EventTypes.OrderPaid:
      intField(v, 'totalCents', 0);
      break;
    case EventTypes.StockReserved:
      lines(v.lines, 'lines', (l) => {
        uuidField(l, 'productId');
        intField(l, 'unitPriceCents', 0);
      });
      break;
    case EventTypes.StockRejected:
      if (!REJECTION_REASONS.includes(v.reason as never)) throw new ContractError(`unknown reason ${String(v.reason)}`);
      break;
    case EventTypes.OrderCancelled:
      break;
  }
  return v as unknown as AnyEvent;
}
