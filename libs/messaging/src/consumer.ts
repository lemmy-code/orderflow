import { AnyEvent, dlqTopic, parseEvent, Topic } from '@app/contracts';
import { Consumer, Kafka, Producer } from 'kafkajs';
import { LoggerLike } from './logger';
import { backoffMs, decide, errMessage } from './retry';

export interface RawMessage {
  topic: string;
  key: string | null;
  value: string | null;
}

export interface DeadLetter {
  topic: string;
  key: string | null;
  original: string | null;
  error: string;
  attempts: number;
  failedAt: string;
}

export interface ProcessDeps {
  handle(event: AnyEvent): Promise<void>;
  sendToDlq(letter: DeadLetter): Promise<void>;
  sleep(ms: number): Promise<void>;
  baseBackoffMs: number;
  logger?: LoggerLike;
}

/** Parse, handle, retry with backoff, and dead-letter what can't be handled — so one bad message never blocks a partition. */
export async function processMessage(msg: RawMessage, deps: ProcessDeps): Promise<'handled' | 'dead-lettered'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.handle(parseEvent(msg.topic, msg.value));
      return 'handled';
    } catch (err) {
      if (decide(err, attempt) === 'retry') {
        deps.logger?.warn(`${msg.topic} attempt ${attempt} failed: ${errMessage(err)}; retrying`);
        await deps.sleep(backoffMs(attempt, deps.baseBackoffMs));
        continue;
      }
      await deps.sendToDlq({
        topic: msg.topic,
        key: msg.key,
        original: msg.value,
        error: errMessage(err),
        attempts: attempt,
        failedAt: new Date().toISOString(),
      });
      deps.logger?.error(`${msg.topic} message dead-lettered after ${attempt} attempt(s): ${errMessage(err)}`);
      return 'dead-lettered';
    }
  }
}

export interface EventConsumerOptions {
  kafka: Kafka;
  groupId: string;
  topic: Topic;
  handle(event: AnyEvent): Promise<void>;
  logger?: LoggerLike;
  baseBackoffMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EventConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: Producer;

  constructor(private readonly o: EventConsumerOptions) {
    this.consumer = o.kafka.consumer({ groupId: o.groupId });
    this.dlqProducer = o.kafka.producer();
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.o.topic, fromBeginning: true });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        await processMessage(
          { topic: this.o.topic, key: message.key?.toString() ?? null, value: message.value?.toString() ?? null },
          {
            handle: this.o.handle,
            sendToDlq: async (letter) => {
              await this.dlqProducer.send({
                topic: dlqTopic(this.o.topic),
                messages: [{ key: letter.key, value: JSON.stringify(letter) }],
              });
            },
            sleep,
            baseBackoffMs: this.o.baseBackoffMs ?? 200,
            logger: this.o.logger,
          },
        );
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
