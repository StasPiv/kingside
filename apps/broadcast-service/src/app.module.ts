import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { BroadcastModule } from './http/broadcast.module';
import { BroadcastSyncModule } from './sync/broadcast-sync.module';
import { ChessResultsModule } from './chess-results/chess-results.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    RedisModule,
    MetricsModule,
    HealthModule,
    BroadcastModule,
    BroadcastSyncModule,
    ChessResultsModule,
  ],
})
export class AppModule {}
