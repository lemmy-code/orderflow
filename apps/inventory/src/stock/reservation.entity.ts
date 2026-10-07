import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('reservations')
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'order_id' })
  orderId!: string;

  @Column('uuid', { name: 'product_id' })
  productId!: string;

  @Column('integer')
  quantity!: number;

  @Column('varchar', { length: 16 })
  status!: 'ACTIVE' | 'RELEASED';
}
