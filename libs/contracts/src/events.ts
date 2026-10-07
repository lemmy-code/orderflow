import { EventTypes } from './topics';

export interface EventEnvelope {
  eventId: string;
  occurredAt: string;
  orderId: string;
}

export interface OrderItemLine {
  productId: string;
  quantity: number;
}

export interface PricedLine {
  productId: string;
  unitPriceCents: number;
}

export type RejectionReason = 'INSUFFICIENT_STOCK' | 'UNKNOWN_PRODUCT';
export const REJECTION_REASONS: readonly RejectionReason[] = ['INSUFFICIENT_STOCK', 'UNKNOWN_PRODUCT'];

export interface OrderCreated extends EventEnvelope {
  type: typeof EventTypes.OrderCreated;
  items: OrderItemLine[];
}
export interface OrderPaid extends EventEnvelope {
  type: typeof EventTypes.OrderPaid;
  totalCents: number;
}
export interface OrderCancelled extends EventEnvelope {
  type: typeof EventTypes.OrderCancelled;
}
export interface StockReserved extends EventEnvelope {
  type: typeof EventTypes.StockReserved;
  lines: PricedLine[];
}
export interface StockRejected extends EventEnvelope {
  type: typeof EventTypes.StockRejected;
  reason: RejectionReason;
}

export type OrderEvent = OrderCreated | OrderPaid | OrderCancelled;
export type StockEvent = StockReserved | StockRejected;
export type AnyEvent = OrderEvent | StockEvent;
