/** Read when a module initialises, never at import time, and every value has a local default. */
export function ordersConfig() {
  return {
    databaseUrl: process.env.ORDERS_DATABASE_URL ?? 'postgres://orderflow:orderflow@localhost:5432/orders',
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    port: Number(process.env.ORDERS_PORT ?? 3000),
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
  };
}
