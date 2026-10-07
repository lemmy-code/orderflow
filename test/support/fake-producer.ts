import { ProducerLike } from '@app/messaging';

type SendBatchArgs = Parameters<ProducerLike['sendBatch']>[0];

/** Records what would have gone to Kafka; `failNext` makes the next N sends throw like a broker outage. */
export class FakeProducer implements ProducerLike {
  sent: { topic: string; key: string; value: string }[] = [];
  failNext = 0;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async sendBatch(batch: SendBatchArgs) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    for (const tm of batch.topicMessages ?? []) {
      for (const m of tm.messages) this.sent.push({ topic: tm.topic, key: String(m.key), value: String(m.value) });
    }
    return [];
  }
}
