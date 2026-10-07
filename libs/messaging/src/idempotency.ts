import { CreateDateColumn, Entity, EntityManager, PrimaryColumn } from 'typeorm';

@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}

/**
 * Records the event in the caller's transaction. Returns false if it was already processed,
 * so a redelivered Kafka message changes nothing.
 */
export async function markProcessed(m: EntityManager, eventId: string): Promise<boolean> {
  const rows: unknown[] = await m.query(
    'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
    [eventId],
  );
  return rows.length === 1;
}
