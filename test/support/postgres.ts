import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

/** One PostgreSQL container holding both service databases, like docker-compose does. */
export async function startPostgres(): Promise<{
  container: StartedPostgreSqlContainer;
  ordersUrl: string;
  inventoryUrl: string;
}> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orders')
    .withUsername('orderflow')
    .withPassword('orderflow')
    .start();
  const base = `postgres://orderflow:orderflow@${container.getHost()}:${container.getMappedPort(5432)}`;
  const admin = new Client({ connectionString: `${base}/orders` });
  await admin.connect();
  await admin.query('CREATE DATABASE inventory');
  await admin.end();
  return { container, ordersUrl: `${base}/orders`, inventoryUrl: `${base}/inventory` };
}
