import { EventTypes, newEnvelope } from '@app/contracts';
import type { OrderCancelled, OrderCreated, OrderEvent, StockEvent } from '@app/contracts';
import { enqueue, markProcessed } from '@app/messaging';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from './product.entity';
import { Reservation } from './reservation.entity';
import { aggregate, decideReservation } from './stock';

@Injectable()
export class ReservationService {
  constructor(private readonly dataSource: DataSource) {}

  /** Consumer handler for order-events. */
  async handle(event: OrderEvent): Promise<void> {
    switch (event.type) {
      case EventTypes.OrderCreated:
        return this.reserve(event);
      case EventTypes.OrderCancelled:
        return this.release(event);
      case EventTypes.OrderPaid:
        return; // nothing to do: the stock was already taken at reservation
    }
  }

  /** Locks the product rows in id order (no deadlocks), decides, applies, and queues the reply — all in one transaction. */
  async reserve(event: OrderCreated): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (!(await markProcessed(m, event.eventId))) return;
      const items = aggregate(event.items);
      const products = await m
        .createQueryBuilder(Product, 'p')
        .where('p.id IN (:...ids)', { ids: items.map((i) => i.productId) })
        .orderBy('p.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();
      const decision = decideReservation(items, new Map(products.map((p) => [p.id, p])));

      let reply: StockEvent;
      if (decision.ok) {
        for (const i of items) {
          await m.decrement(Product, { id: i.productId }, 'stockAvailable', i.quantity);
          await m.insert(Reservation, { orderId: event.orderId, productId: i.productId, quantity: i.quantity, status: 'ACTIVE' });
        }
        reply = { ...newEnvelope(event.orderId), type: EventTypes.StockReserved, lines: decision.lines };
      } else {
        reply = { ...newEnvelope(event.orderId), type: EventTypes.StockRejected, reason: decision.reason };
      }
      await enqueue(m, reply);
    });
  }

  async release(event: OrderCancelled): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (!(await markProcessed(m, event.eventId))) return;
      const active = await m.find(Reservation, {
        where: { orderId: event.orderId, status: 'ACTIVE' },
        order: { productId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      for (const r of active) {
        await m.increment(Product, { id: r.productId }, 'stockAvailable', r.quantity);
        r.status = 'RELEASED';
      }
      await m.save(active);
    });
  }
}
