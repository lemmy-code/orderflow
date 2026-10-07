import { Topics } from '@app/contracts';
import type { StockEvent } from '@app/contracts';
import { createKafka, ensureTopics, EventConsumer, OutboxPublisher } from '@app/messaging';
import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ordersConfig } from './config';
import { OrdersService } from './orders/orders.service';

@Injectable()
export class OrdersMessaging implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private publisher?: OutboxPublisher;
  private consumer?: EventConsumer;

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrdersService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.ORDERS_MESSAGING === 'off') return;
    const cfg = ordersConfig();
    const kafka = createKafka('orders', cfg.kafkaBrokers);
    await ensureTopics(kafka);
    this.publisher = new OutboxPublisher(this.dataSource, kafka.producer({ maxInFlightRequests: 1 }), {
      intervalMs: cfg.outboxIntervalMs,
      logger: new Logger('OrdersOutbox'),
    });
    await this.publisher.start();
    this.consumer = new EventConsumer({
      kafka,
      groupId: 'orders',
      topic: Topics.StockEvents,
      handle: (e) => this.orders.applyStockReply(e as StockEvent), // parseEvent guarantees stock-events carry stock events
      logger: new Logger('StockEventsConsumer'),
    });
    await this.consumer.start();
  }

  // Before TypeORM closes its pool, so an in-flight batch can finish.
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
    await this.publisher?.stop();
  }
}
