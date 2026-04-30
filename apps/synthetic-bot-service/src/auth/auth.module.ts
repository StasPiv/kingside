import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotTokenService } from './bot-token.service';
import { TokenCacheService } from './token-cache.service';

/**
 * AuthModule — выдача и кэширование JWT-токенов для synthetic-ботов
 * (ADR-034-v2 §2.2, B1v2).
 *
 * Экспортирует `BotTokenService` и `TokenCacheService` для использования
 * `BotManager` (B2v2) и `BotInstance` (B3v2). Сам по себе никак не
 * подключается к WebSocket'у — это уровень выше.
 */
@Module({
  imports: [ConfigModule],
  providers: [BotTokenService, TokenCacheService],
  exports: [BotTokenService, TokenCacheService],
})
export class AuthModule {}
