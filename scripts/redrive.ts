/**
 * Replays dead-lettered events back onto their topic.
 *   KAFKA_BROKERS=localhost:9094 npm run redrive -- order-events
 */
import { Topics } from '@app/contracts';
import type { Topic } from '@app/contracts';
import { createKafka } from '../libs/messaging/src/kafka';
import { redrive } from '../libs/messaging/src/redrive';

async function main(): Promise<void> {
  const topic = process.argv[2] as Topic;
  if (!Object.values(Topics).includes(topic)) {
    console.error(`usage: npm run redrive -- <${Object.values(Topics).join(' | ')}>`);
    process.exit(2);
  }
  const kafka = createKafka('redrive', (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','));
  const { redriven, skipped } = await redrive(kafka, topic);
  console.log(`${topic}: ${redriven} replayed, ${skipped} skipped (contract violations stay in ${topic}.dlq)`);
}
void main();
