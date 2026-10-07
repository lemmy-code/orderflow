import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Order } from './order.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column('uuid', { name: 'product_id' })
  productId!: string;

  @Column('integer')
  quantity!: number;

  @Column('integer', { name: 'unit_price_cents', nullable: true })
  unitPriceCents!: number | null;
}
