import { Module, OnModuleInit } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { SyntheticPresenceService } from './synthetic/synthetic-presence.service';
import { SyntheticSchedulerService } from './synthetic/synthetic-scheduler.service';
import { StockfishPoolService } from './synthetic/engine/stockfish-pool.service';
import { SyntheticMoveEngineService } from './synthetic/engine/synthetic-move-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type {
  SyntheticDeps,
  SyntheticPrisma,
  SyntheticRedis,
} from './synthetic/synthetic-deps';

/**
 * KS-2164. SyntheticPresence/Scheduler регистрируются здесь же —
 * MatchmakingService им нужен через DI, отдельный sub-module повлёк
 * бы циркулярную зависимость. `wire()` в onModuleInit пробрасывает
 * Prisma/Redis/MatchmakingService в presence/scheduler через
 * `configure(...)` — это выбрано вместо `@Inject` token'ов потому что
 * presence получает не полный MatchmakingService, а узкий API
 * (`MatchmakingApi`).
 *
 * Активация всех synthetic-функций — env `SYNTHETIC_SCHEDULER_ENABLED=true`.
 * Без флага оба сервиса конструируются, но ничего не делают (см. их
 * onModuleInit'ы).
 */
@Module({
  imports: [AuthModule, GameModule],
  providers: [
    MatchmakingService,
    MatchmakingGateway,
    SyntheticPresenceService,
    SyntheticSchedulerService,
    StockfishPoolService,
    SyntheticMoveEngineService,
  ],
  exports: [
    MatchmakingService,
    SyntheticPresenceService,
    SyntheticSchedulerService,
    StockfishPoolService,
    SyntheticMoveEngineService,
  ],
})
export class MatchmakingModule implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly matchmaking: MatchmakingService,
    private readonly presence: SyntheticPresenceService,
    private readonly scheduler: SyntheticSchedulerService,
  ) {}

  onModuleInit(): void {
    const deps: SyntheticDeps = {
      prisma: this.prisma as unknown as SyntheticPrisma,
      redis: this.redis as unknown as SyntheticRedis,
    };
    this.presence.configure(deps, {
      joinQueue: (...args) => this.matchmaking.joinQueue(...args),
      leaveQueue: (...args) => this.matchmaking.leaveQueue(...args),
    });
    this.scheduler.configure(deps, this.presence);
  }
}
