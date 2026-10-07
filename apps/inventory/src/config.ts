/** Read when a module initialises, never at import time, and every value has a local default. */
export function inventoryConfig() {
  return {
    databaseUrl: process.env.INVENTORY_DATABASE_URL ?? 'postgres://orderflow:orderflow@localhost:5432/inventory',
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
  };
}
