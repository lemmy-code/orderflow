import { ContractError, EventTypes, newEnvelope, OrderEvent, OrderItemLine, StockEvent } from '@app/contracts';
import { enqueue, markProcessed } from '@app/messaging';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OrderNotFoundError } from './errors';
import { assertUuid, validateItems } from './order-input';
import { OrderItem } from './order-item.entity';
import { assertTransition } from './order-state';
import { OrderStatus } from './order-status';
import { Order } from './order.entity';
import { decodeCursor, encodeCursor, pageSize } from './pagination';

export interface OrderPage {
  nodes: Order[];
  endCursor: string | null;
  hasNextPage: boolean;
}

@Injectable()
export class OrdersService {
  constructor(private readonly dataSource: DataSource) {}

  async create(items: OrderItemLine[]): Promise<Order> {
    validateItems(items);
    return this.dataSource.transaction(async (m) => {
      const order = m.create(Order, {
        status: OrderStatus.PENDING,
        totalCents: null,
        rejectionReason: null,
        items: items.map((i) => m.create(OrderItem, { productId: i.productId, quantity: i.quantity, unitPriceCents: null })),
      });
      await m.save(order);
      await enqueue(m, {
        ...newEnvelope(order.id),
        type: EventTypes.OrderCreated,
        items: items.map(({ productId, quantity }) => ({ productId, quantity })),
      });
      return order;
    });
  }

  pay(id: string): Promise<Order> {
    return this.transition(id, OrderStatus.PAID, (o) => ({
      ...newEnvelope(o.id),
      type: EventTypes.OrderPaid,
      totalCents: o.totalCents ?? 0,
    }));
  }

  cancel(id: string): Promise<Order> {
    return this.transition(id, OrderStatus.CANCELLED, (o) => ({ ...newEnvelope(o.id), type: EventTypes.OrderCancelled }));
  }

  async findById(id: string): Promise<Order | null> {
    assertUuid(id, 'id');
    return this.dataSource.getRepository(Order).findOne({ where: { id }, relations: { items: true } });
  }

  async list(o: { status?: OrderStatus | null; first?: number | null; after?: string | null }): Promise<OrderPage> {
    const limit = pageSize(o.first);
    const qb = this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'i')
      .orderBy('o.createdAt', 'ASC')
      .addOrderBy('o.id', 'ASC')
      .take(limit + 1);
    if (o.status) qb.andWhere('o.status = :status', { status: o.status });
    if (o.after) qb.andWhere('(o.created_at, o.id) > (:createdAt, :id)', decodeCursor(o.after));
    const rows = await qb.getMany();
    const nodes = rows.slice(0, limit);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > limit, endCursor: last ? encodeCursor(last) : null };
  }

  /** Consumer handler for stock-events. Idempotent, and a no-op once the order has left PENDING. */
  async applyStockReply(event: StockEvent): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (!(await markProcessed(m, event.eventId))) return;
      const order = await m.findOne(Order, { where: { id: event.orderId }, lock: { mode: 'pessimistic_write' } });
      if (!order || order.status !== OrderStatus.PENDING) return;

      if (event.type === EventTypes.StockReserved) {
        const prices = new Map(event.lines.map((l) => [l.productId, l.unitPriceCents]));
        const items = await m.find(OrderItem, { where: { order: { id: order.id } } });
        let total = 0;
        for (const item of items) {
          const price = prices.get(item.productId);
          // Rolls back markProcessed too; the consumer dead-letters ContractError without retrying.
          if (price === undefined) throw new ContractError(`stock.reserved has no price for product ${item.productId}`);
          item.unitPriceCents = price;
          total += price * item.quantity;
        }
        await m.save(items);
        order.status = OrderStatus.RESERVED;
        order.totalCents = total;
      } else {
        order.status = OrderStatus.REJECTED;
        order.rejectionReason = event.reason;
      }
      await m.save(order);
    });
  }

  private async transition(id: string, to: OrderStatus, event: (o: Order) => OrderEvent): Promise<Order> {
    assertUuid(id, 'id');
    return this.dataSource.transaction(async (m: EntityManager) => {
      const order = await m.findOne(Order, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!order) throw new OrderNotFoundError(id);
      assertTransition(order.status, to);
      order.status = to;
      await m.save(order);
      await enqueue(m, event(order));
      return m.findOneOrFail(Order, { where: { id }, relations: { items: true } });
    });
  }
}
