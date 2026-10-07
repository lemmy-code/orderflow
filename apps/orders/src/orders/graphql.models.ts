import { Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { OrderStatus } from './order-status';

registerEnumType(OrderStatus, { name: 'OrderStatus' });

@ObjectType('OrderItem')
export class OrderItemModel {
  @Field(() => ID) productId!: string;
  @Field(() => Int) quantity!: number;
  @Field(() => Int, { nullable: true }) unitPriceCents!: number | null;
}

@ObjectType('Order')
export class OrderModel {
  @Field(() => ID) id!: string;
  @Field(() => OrderStatus) status!: OrderStatus;
  @Field(() => Int, { nullable: true, description: 'Known once inventory has reserved the stock' }) totalCents!: number | null;
  @Field(() => String, { nullable: true }) rejectionReason!: string | null;
  @Field(() => [OrderItemModel]) items!: OrderItemModel[];
  @Field(() => GraphQLISODateTime) createdAt!: Date;
}

@ObjectType('OrderPage')
export class OrderPageModel {
  @Field(() => [OrderModel]) nodes!: OrderModel[];
  @Field(() => String, { nullable: true }) endCursor!: string | null;
  @Field(() => Boolean) hasNextPage!: boolean;
}

@InputType()
export class OrderItemInput {
  @Field(() => ID) productId!: string;
  @Field(() => Int) quantity!: number;
}
