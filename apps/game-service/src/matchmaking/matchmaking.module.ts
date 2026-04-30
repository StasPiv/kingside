import { Module } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';

/**
 * Matchmaking-модуль game-service.
 *
 * Архитектура synthetic-users (KS-2159..KS-2180) откатана 30.04 —
 * embedded-вариант (Stockfish pool + bot-логика в этом же процессе)
 * признан неверным архитектурным решением. Замена — отдельный
 * WebSocket-bot-fleet, синтетики подключаются как обычные клиенты
 * (ADR-034 v2 в работе у архитектора). Поля БД остались
 * (`users.is_synthetic`, `users.country`, `games.is_synthetic_opponent`),
 * shared-types в `@kingside/shared/synthetic` тоже — на момент готовности
 * v2 их можно будет переиспользовать.
 */
@Module({
  imports: [AuthModule, GameModule],
  providers: [MatchmakingService, MatchmakingGateway],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
