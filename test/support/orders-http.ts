import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';
import { OrdersAppModule } from '../../apps/orders/src/app.module';

/** The real orders GraphQL app on a random port, without Kafka (orders stay PENDING). */
export async function startOrdersHttp(ordersUrl: string): Promise<{ app: INestApplication; graphqlUrl: string }> {
  process.env.ORDERS_DATABASE_URL = ordersUrl;
  process.env.ORDERS_MESSAGING = 'off';
  const app = await NestFactory.create(OrdersAppModule, { logger: ['error'] });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, graphqlUrl: `http://127.0.0.1:${port}/graphql` };
}
