import { DROP_MESSAGING_TABLES_SQL, MESSAGING_TABLES_SQL } from '@app/messaging';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { SEED_PRODUCTS } from '../stock/seed';

export class InitInventory1728300000001 implements MigrationInterface {
  name = 'InitInventory1728300000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE products (
        id              uuid PRIMARY KEY,
        sku             varchar(32)  NOT NULL UNIQUE,
        name            varchar(120) NOT NULL,
        price_cents     integer NOT NULL CHECK (price_cents >= 0),
        stock_available integer NOT NULL CHECK (stock_available >= 0)
      );
      CREATE TABLE reservations (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id   uuid NOT NULL,
        product_id uuid NOT NULL REFERENCES products(id),
        quantity   integer NOT NULL CHECK (quantity > 0),
        status     varchar(16) NOT NULL
      );
      CREATE INDEX reservations_order_idx ON reservations (order_id);
    `);
    await q.query(MESSAGING_TABLES_SQL);
    for (const p of SEED_PRODUCTS) {
      await q.query('INSERT INTO products (id, sku, name, price_cents, stock_available) VALUES ($1, $2, $3, $4, $5)', [
        p.id,
        p.sku,
        p.name,
        p.priceCents,
        p.stock,
      ]);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(DROP_MESSAGING_TABLES_SQL);
    await q.query('DROP TABLE reservations; DROP TABLE products;');
  }
}
