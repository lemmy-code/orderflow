import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 16 })
  status!: OrderStatus;

  @Column('integer', { name: 'total_cents', nullable: true })
  totalCents!: number | null;

  @Column('varchar', { name: 'rejection_reason', length: 32, nullable: true })
  rejectionReason!: string | null;

  // Not eager: FOR UPDATE can't lock the nullable side of the LEFT JOIN an eager relation adds.
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items!: OrderItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
