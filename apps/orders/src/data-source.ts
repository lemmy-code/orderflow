import { OutboxMessage, ProcessedEvent } from '@app/messaging';
import { DataSourceOptions } from 'typeorm';
import { InitOrders1728300000000 } from './migrations/1728300000000-init-orders';
import { OrderItem } from './orders/order-item.entity';
import { Order } from './orders/order.entity';

export function ordersDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [Order, OrderItem, OutboxMessage, ProcessedEvent],
    migrations: [InitOrders1728300000000],
    migrationsRun: true,
    synchronize: false,
  };
}
