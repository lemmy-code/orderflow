import { EventTypes, newEnvelope, OrderCancelled } from '@app/contracts';
import {
  enqueue,
  markProcessed,
  MESSAGING_TABLES_SQL,
  OutboxMessage,
  OutboxPublisher,
  ProcessedEvent,
} from '@app/messaging';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { FakeProducer } from '../support/fake-producer';
import { startPostgres } from '../support/postgres';

const ORDER = '9f1e2d3c-4b5a-4c69-8d7e-6f5a4b3c2d1e';
const cancelled = (): OrderCancelled => ({ ...newEnvelope(ORDER), type: EventTypes.OrderCancelled });

describe('messaging persistence', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    const started = await startPostgres();
    pg = started.container;
    ds = await new DataSource({ type: 'postgres', url: started.ordersUrl, entities: [OutboxMessage, ProcessedEvent] }).initialize();
    await ds.query(MESSAGING_TABLES_SQL);
  });
  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });
  beforeEach(() => ds.query('TRUNCATE outbox, processed_events'));

  describe('markProcessed', () => {
    it('returns true the first time and false for a repeat', async () => {
      const id = newEnvelope(ORDER).eventId;
      await expect(ds.transaction((m) => markProcessed(m, id))).resolves.toBe(true);
      await expect(ds.transaction((m) => markProcessed(m, id))).resolves.toBe(false);
    });

    it('is rolled back with the transaction it ran in', async () => {
      const id = newEnvelope(ORDER).eventId;
      await expect(
        ds.transaction(async (m) => {
          await markProcessed(m, id);
          throw new Error('handler failed');
        }),
      ).rejects.toThrow('handler failed');
      await expect(ds.transaction((m) => markProcessed(m, id))).resolves.toBe(true);
    });
  });

  describe('OutboxPublisher.publishBatch', () => {
    it('publishes unsent rows in order, keyed by orderId, and marks them sent', async () => {
      const a = cancelled();
      const b = cancelled();
      await ds.transaction(async (m) => {
        await enqueue(m, a);
        await enqueue(m, b);
      });
      const producer = new FakeProducer();
      const publisher = new OutboxPublisher(ds, producer, { intervalMs: 1000 });

      await expect(publisher.publishBatch()).resolves.toBe(2);
      expect(producer.sent.map((s) => JSON.parse(s.value).eventId)).toEqual([a.eventId, b.eventId]);
      expect(producer.sent.every((s) => s.topic === 'order-events' && s.key === ORDER)).toBe(true);
      await expect(publisher.publishBatch()).resolves.toBe(0);
      expect(producer.sent).toHaveLength(2);
    });

    it('keeps rows unsent when Kafka is down and sends them on the next run', async () => {
      await ds.transaction((m) => enqueue(m, cancelled()));
      const producer = new FakeProducer();
      producer.failNext = 1;
      const publisher = new OutboxPublisher(ds, producer, { intervalMs: 1000 });

      await expect(publisher.publishBatch()).rejects.toThrow('broker unavailable');
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM outbox WHERE sent_at IS NULL`);
      expect(count).toBe(1);

      await expect(publisher.publishBatch()).resolves.toBe(1);
      expect(producer.sent).toHaveLength(1);
    });
  });
});
