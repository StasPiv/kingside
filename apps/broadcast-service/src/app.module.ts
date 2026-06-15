import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { BroadcastModule } from './http/broadcast.module';
import { BroadcastSyncModule } from './sync/broadcast-sync.module';
import { ChessResultsModule } from './chess-results/chess-results.module';
// KS-4205 / ADR-128 §10 #11 §7.3.7. Глобальная шина postановки
// prerender-задач (mutation hooks в sync- и watchdog-сервисах).
import { PrerenderModule } from './prerender/prerender.module';
// KS-4221. Admin-эндпоинты (разовая переиндексация трансляций).
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    RedisModule,
    PrerenderModule,
    AdminModule,
    MetricsModule,
    HealthModule,
    BroadcastModule,
    BroadcastSyncModule,
    ChessResultsModule,
  ],
})
export class AppModule {}
