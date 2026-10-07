import { NestFactory } from '@nestjs/core';
import { InventoryAppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // No HTTP: inventory only listens to Kafka.
  const app = await NestFactory.createApplicationContext(InventoryAppModule);
  app.enableShutdownHooks();
}
void bootstrap();
