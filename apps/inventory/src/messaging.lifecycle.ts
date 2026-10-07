import { Topics } from '@app/contracts';
import type { OrderEvent } from '@app/contracts';
import { createKafka, ensureTopics, EventConsumer, OutboxPublisher } from '@app/messaging';
import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { inventoryConfig } from './config';
import { ReservationService } from './stock/reservation.service';

@Injectable()
export class InventoryMessaging implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private publisher?: OutboxPublisher;
  private consumer?: EventConsumer;

  constructor(
    private readonly dataSource: DataSource,
    private readonly reservations: ReservationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const cfg = inventoryConfig();
    const kafka = createKafka('inventory', cfg.kafkaBrokers);
    await ensureTopics(kafka);
    this.publisher = new OutboxPublisher(this.dataSource, kafka.producer({ maxInFlightRequests: 1 }), {
      intervalMs: cfg.outboxIntervalMs,
      logger: new Logger('InventoryOutbox'),
    });
    await this.publisher.start();
    this.consumer = new EventConsumer({
      kafka,
      groupId: 'inventory',
      topic: Topics.OrderEvents,
      handle: (e) => this.reservations.handle(e as OrderEvent), // parseEvent guarantees order-events carry order events
      logger: new Logger('OrderEventsConsumer'),
    });
    await this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
    await this.publisher?.stop();
  }
}
