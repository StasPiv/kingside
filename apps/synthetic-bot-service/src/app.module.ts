import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { AuthModule } from './auth/auth.module';

/**
 * Synthetic Bot Service — корневой модуль.
 *
 * Состав на B1v2:
 *   - HealthController — liveness `/health` (B0v2).
 *   - AuthModule — `BotTokenService` + `TokenCacheService` (B1v2).
 *
 * Бизнес-логика (BotManager / BotInstance / StockfishPool / Scheduler)
 * добавится в B2v2..B6v2.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
