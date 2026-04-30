import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotManager } from './bot-manager.service';

/**
 * BotManagerModule — orchestrator одного ECS-task'а (ADR-034-v2 §3.3, §5).
 *
 * Экспортирует `BotManager` для будущих модулей:
 *   - B3v2 (`BotInstance`) — регистрирует свои инстансы;
 *   - B5v2 (`Scheduler`) — спрашивает `getMyBots()` и зовёт `spawn`/`despawn`.
 */
@Module({
  imports: [ConfigModule],
  providers: [BotManager],
  exports: [BotManager],
})
export class BotManagerModule {}
