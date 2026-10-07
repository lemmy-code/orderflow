import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { withGraphQLErrors } from './graphql-errors';
import { OrderItemInput, OrderModel, OrderPageModel } from './graphql.models';
import { OrderStatus } from './order-status';
import { OrdersService } from './orders.service';
import type { OrderPage } from './orders.service';
import type { Order } from './order.entity';

@Resolver(() => OrderModel)
export class OrdersResolver {
  constructor(private readonly ordersService: OrdersService) {}

  @Mutation(() => OrderModel)
  createOrder(@Args('items', { type: () => [OrderItemInput] }) items: OrderItemInput[]): Promise<Order> {
    return withGraphQLErrors(() => this.ordersService.create(items));
  }

  @Mutation(() => OrderModel, { description: 'Simulated payment; only a RESERVED order can be paid' })
  payOrder(@Args('id', { type: () => ID }) id: string): Promise<Order> {
    return withGraphQLErrors(() => this.ordersService.pay(id));
  }

  @Mutation(() => OrderModel)
  cancelOrder(@Args('id', { type: () => ID }) id: string): Promise<Order> {
    return withGraphQLErrors(() => this.ordersService.cancel(id));
  }

  @Query(() => OrderModel, { nullable: true })
  order(@Args('id', { type: () => ID }) id: string): Promise<Order | null> {
    return withGraphQLErrors(() => this.ordersService.findById(id));
  }

  @Query(() => OrderPageModel)
  orders(
    @Args('status', { type: () => OrderStatus, nullable: true }) status?: OrderStatus | null,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
    @Args('after', { type: () => String, nullable: true }) after?: string | null,
  ): Promise<OrderPage> {
    return withGraphQLErrors(() => this.ordersService.list({ status, first, after }));
  }
}
