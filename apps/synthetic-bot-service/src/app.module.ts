import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Synthetic Bot Service — корневой модуль.
 *
 * Скелет (B0v2). Бизнес-логика будет добавлена в задачах:
 *   - B1v2 (BotTokenService)
 *   - B2v2 (BotManager)
 *   - B3v2 (BotInstance + Game WS client)
 *   - B4v2 (StockfishPool)
 *   - B5v2 (Scheduler + Redis sharding)
 *   - B6v2 (профили ботов, рейтинговая выборка)
 */
@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
