import { DROP_MESSAGING_TABLES_SQL, MESSAGING_TABLES_SQL } from '@app/messaging';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitOrders1728300000000 implements MigrationInterface {
  name = 'InitOrders1728300000000';

  async up(q: QueryRunner): Promise<void> {
    // timestamptz(3): millisecond precision, so a JS Date round-trips exactly in pagination cursors.
    await q.query(`
      CREATE TABLE orders (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status           varchar(16) NOT NULL,
        total_cents      integer,
        rejection_reason varchar(32),
        created_at       timestamptz(3) NOT NULL DEFAULT now(),
        updated_at       timestamptz(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX orders_created_idx ON orders (created_at, id);
      CREATE INDEX orders_status_created_idx ON orders (status, created_at, id);
      CREATE TABLE order_items (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id       uuid NOT NULL,
        quantity         integer NOT NULL CHECK (quantity > 0),
        unit_price_cents integer
      );
      CREATE INDEX order_items_order_idx ON order_items (order_id);
    `);
    await q.query(MESSAGING_TABLES_SQL);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(DROP_MESSAGING_TABLES_SQL);
    await q.query('DROP TABLE order_items; DROP TABLE orders;');
  }
}
