import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { inventoryConfig } from './config';
import { inventoryDataSourceOptions } from './data-source';
import { InventoryMessaging } from './messaging.lifecycle';
import { ReservationService } from './stock/reservation.service';

@Module({
  imports: [TypeOrmModule.forRootAsync({ useFactory: () => inventoryDataSourceOptions(inventoryConfig().databaseUrl) })],
  providers: [ReservationService, InventoryMessaging],
})
export class InventoryAppModule {}
