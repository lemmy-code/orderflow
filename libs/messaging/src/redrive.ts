import { dlqTopic, parseEvent, Topic } from '@app/contracts';
import { Kafka } from 'kafkajs';
import type { DeadLetter } from './consumer';
import { LoggerLike } from './logger';

function isDeadLetter(v: unknown): v is DeadLetter {
  const d = v as Partial<DeadLetter> | null;
  return typeof d === 'object' && d !== null && typeof d.topic === 'string' && 'original' in d;
}

/**
 * What to republish for one dead letter, or null to skip it. Only events that still pass the contract are
 * replayed: a contract violation would just be dead-lettered again. Replaying is safe because every consumer
 * ignores an eventId it has already processed.
 */
export function planRedrive(letter: unknown): { key: string | null; value: string } | null {
  if (!isDeadLetter(letter) || letter.original === null) return null;
  try {
    parseEvent(letter.topic, letter.original);
  } catch {
    return null;
  }
  return { key: letter.key, value: letter.original };
}

/**
 * Moves dead letters for `topic` back onto it. Uses its own consumer group, so each letter is replayed once,
 * and stops after `idleMs` with no new letter.
 */
export async function redrive(
  kafka: Kafka,
  topic: Topic,
  o: { idleMs?: number; logger?: LoggerLike } = {},
): Promise<{ redriven: number; skipped: number }> {
  const consumer = kafka.consumer({ groupId: `redrive-${topic}` });
  const producer = kafka.producer();
  const counts = { redriven: 0, skipped: 0 };
  let lastActivity = Date.now();
  await producer.connect();
  await consumer.connect();
  try {
    await consumer.subscribe({ topic: dlqTopic(topic), fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        lastActivity = Date.now();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(String(message.value));
        } catch {
          // not a dead letter we wrote; skipped below
        }
        const plan = planRedrive(parsed);
        if (!plan) {
          counts.skipped++;
          return;
        }
        await producer.send({ topic, messages: [plan] });
        counts.redriven++;
      },
    });
    const idleMs = o.idleMs ?? 5_000;
    while (Date.now() - lastActivity < idleMs) await new Promise((r) => setTimeout(r, 250));
  } finally {
    await consumer.disconnect();
    await producer.disconnect();
  }
  o.logger?.log(`redrive ${topic}: ${counts.redriven} replayed, ${counts.skipped} skipped`);
  return counts;
}
