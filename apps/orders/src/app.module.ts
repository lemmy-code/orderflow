import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ordersConfig } from './config';
import { ordersDataSourceOptions } from './data-source';
import { HealthController } from './health.controller';
import { OrdersMessaging } from './messaging.lifecycle';
import { OrdersResolver } from './orders/orders.resolver';
import { OrdersService } from './orders/orders.service';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true, sortSchema: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => ordersDataSourceOptions(ordersConfig().databaseUrl) }),
  ],
  controllers: [HealthController],
  providers: [OrdersService, OrdersResolver, OrdersMessaging],
})
export class OrdersAppModule {}
