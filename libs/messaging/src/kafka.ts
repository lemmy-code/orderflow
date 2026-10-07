import { ALL_TOPICS } from '@app/contracts';
import { Kafka, logLevel } from 'kafkajs';

export function createKafka(clientId: string, brokers: string[]): Kafka {
  return new Kafka({ clientId, brokers, logLevel: logLevel.WARN });
}

function isAlreadyExists(e: unknown): boolean {
  const errors = (e as { errors?: { type?: string }[] }).errors;
  return Array.isArray(errors) && errors.length > 0 && errors.every((x) => x.type === 'TOPIC_ALREADY_EXISTS');
}

/** Idempotent: both services call it on boot, possibly at the same time. */
export async function ensureTopics(kafka: Kafka, numPartitions = 3): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: ALL_TOPICS.map((topic) => ({ topic, numPartitions, replicationFactor: 1 })),
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  } finally {
    await admin.disconnect();
  }
}
