import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('varchar', { length: 32, unique: true })
  sku!: string;

  @Column('varchar', { length: 120 })
  name!: string;

  @Column('integer', { name: 'price_cents' })
  priceCents!: number;

  @Column('integer', { name: 'stock_available' })
  stockAvailable!: number;
}
