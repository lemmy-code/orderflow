import { OutboxMessage, ProcessedEvent } from '@app/messaging';
import { DataSourceOptions } from 'typeorm';
import { InitInventory1728300000001 } from './migrations/1728300000001-init-inventory';
import { Product } from './stock/product.entity';
import { Reservation } from './stock/reservation.entity';

export function inventoryDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [Product, Reservation, OutboxMessage, ProcessedEvent],
    migrations: [InitInventory1728300000001],
    migrationsRun: true,
    synchronize: false,
  };
}
