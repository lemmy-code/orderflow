import { NestFactory } from '@nestjs/core';
import { OrdersAppModule } from './app.module';
import { ordersConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(OrdersAppModule);
  app.enableShutdownHooks();
  await app.listen(ordersConfig().port);
}
void bootstrap();
