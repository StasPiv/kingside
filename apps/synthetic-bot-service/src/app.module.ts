import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { AuthModule } from './auth/auth.module';
import { BotManagerModule } from './manager/bot-manager.module';

/**
 * Synthetic Bot Service — корневой модуль.
 *
 * Состав на B2v2:
 *   - HealthController — liveness `/health` (B0v2).
 *   - AuthModule — `BotTokenService` + `TokenCacheService` (B1v2).
 *   - BotManagerModule — `BotManager` (B2v2: шардирование, locks, lifecycle).
 *
 * Бизнес-логика (BotInstance / StockfishPool / Scheduler) добавится
 * в B3v2..B6v2.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    BotManagerModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
