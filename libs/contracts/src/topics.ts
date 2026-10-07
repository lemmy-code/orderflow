export const Topics = { OrderEvents: 'order-events', StockEvents: 'stock-events' } as const;
export type Topic = (typeof Topics)[keyof typeof Topics];

export const EventTypes = {
  OrderCreated: 'order.created',
  OrderPaid: 'order.paid',
  OrderCancelled: 'order.cancelled',
  StockReserved: 'stock.reserved',
  StockRejected: 'stock.rejected',
} as const;
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export const dlqTopic = (topic: Topic): string => `${topic}.dlq`;

/** One topic per stream: every event for one order shares a topic, so Kafka keeps them in order. */
export const topicFor = (type: EventType): Topic => (type.startsWith('order.') ? Topics.OrderEvents : Topics.StockEvents);

export const ALL_TOPICS: string[] = [
  Topics.OrderEvents,
  Topics.StockEvents,
  dlqTopic(Topics.OrderEvents),
  dlqTopic(Topics.StockEvents),
];
