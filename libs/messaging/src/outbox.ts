import type { AnyEvent } from '@app/contracts';
import { topicFor } from '@app/contracts';
import { Producer } from 'kafkajs';
import { Column, CreateDateColumn, DataSource, Entity, EntityManager, In, PrimaryGeneratedColumn } from 'typeorm';
import { LoggerLike } from './logger';
import { errMessage } from './retry';

@Entity('outbox')
export class OutboxMessage {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  seq!: string;

  @Column('uuid', { name: 'event_id', unique: true })
  eventId!: string;

  @Column('varchar', { length: 64 })
  topic!: string;

  @Column('varchar', { length: 64 })
  key!: string;

  @Column('jsonb')
  payload!: AnyEvent;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'sent_at', nullable: true })
  sentAt!: Date | null;
}

/** Call inside the same transaction as the state change the event describes. */
export async function enqueue(m: EntityManager, event: AnyEvent): Promise<void> {
  await m.insert(OutboxMessage, { eventId: event.eventId, topic: topicFor(event.type), key: event.orderId, payload: event });
}

/** Advisory-lock key: only the publisher holding it may send, so outbox order is publish order. */
export const OUTBOX_LOCK_KEY = 4_242_001;

export type ProducerLike = Pick<Producer, 'connect' | 'disconnect' | 'sendBatch'>;

export interface OutboxPublisherOptions {
  intervalMs: number;
  batchSize?: number;
  logger?: LoggerLike;
}

export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(
    private readonly ds: DataSource,
    private readonly producer: ProducerLike,
    private readonly o: OutboxPublisherOptions,
  ) {}

  async start(): Promise<void> {
    await this.producer.connect();
    this.timer = setInterval(() => {
      if (this.inFlight) return; // never overlap two batches
      this.inFlight = this.publishBatch()
        .then(() => undefined)
        .catch((e) => this.o.logger?.warn(`outbox publish failed, will retry: ${errMessage(e)}`))
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.o.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
    await this.producer.disconnect();
  }

  /**
   * Sends the oldest unsent rows and marks them sent, in one transaction. If Kafka throws, the transaction
   * rolls back and the rows go out on a later run (so a row can be sent twice; consumers dedupe by eventId).
   * A transaction-scoped advisory lock admits one publisher at a time: with several service instances, two
   * publishers sending interleaved batches could deliver an order's events out of order.
   */
  async publishBatch(): Promise<number> {
    return this.ds.transaction(async (m) => {
      const [{ locked }]: { locked: boolean }[] = await m.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [
        OUTBOX_LOCK_KEY,
      ]);
      if (!locked) return 0; // another instance is publishing; it will send these rows in order
      const rows = await m
        .createQueryBuilder(OutboxMessage, 'o')
        .where('o.sent_at IS NULL')
        .orderBy('o.seq', 'ASC')
        .limit(this.o.batchSize ?? 100)
        .getMany();
      if (rows.length === 0) return 0;

      const byTopic = new Map<string, { key: string; value: string }[]>();
      for (const row of rows) {
        const list = byTopic.get(row.topic) ?? [];
        list.push({ key: row.key, value: JSON.stringify(row.payload) });
        byTopic.set(row.topic, list);
      }
      await this.producer.sendBatch({
        topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
      });
      await m.update(OutboxMessage, { seq: In(rows.map((r) => r.seq)) }, { sentAt: new Date() });
      return rows.length;
    });
  }
}
