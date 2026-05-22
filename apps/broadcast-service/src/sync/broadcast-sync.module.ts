import { Module } from '@nestjs/common';
import { BroadcastSyncService } from './broadcast-sync.service';
import { SyncMetricsService } from './sync-metrics';
import { BroadcastWatchdogService } from './broadcast-watchdog.service';
import { BroadcastGameCountMetricService } from './broadcast-game-count-metric.service';
import { ChessResultsModule } from '../chess-results/chess-results.module';
import { InternalKeyGuard } from './internal-key.guard';
import { BroadcastInternalController } from './broadcast-internal.controller';
import { BroadcastInternalGamesController } from './internal-games.controller';

/**
 * Sync-модуль broadcast-service (ADR-022 §2.2).
 *
 * Объединяет логику, перенесённую из `apps/broadcast-worker/src/worker.ts`
 * (sync/pinned-poll/stale-check/pgn-fetch/FEN). HTTP-часть broadcast-service
 * в `http/` не импортит sync-модуль — они изолированы.
 *
 * `PrismaModule`, `RedisModule`, `MetricsModule` — `@Global()`, DI найдёт их
 * автоматически.
 *
 * KS-2158: добавлен `BroadcastWatchdogService` — раз в минуту проверяет
 * раунды со status='ongoing', last_update_at старше 30 мин, и закрывает
 * те, что подтверждены завершёнными от Lichess (или 3× подряд unreachable).
 * Опт-ин через env `BROADCAST_WATCHDOG_ENABLED=true`.
 */
@Module({
  // KS-2723: импортируем `ChessResultsModule` чтобы получить
  // `BroadcastStandingsSyncService` для event-driven инвалидации
  // кэша из `BroadcastSyncService.processPgnUpdate`.
  imports: [ChessResultsModule],
  // KS-2883 (B10): BroadcastInternalController обслуживает api-вызовы
  // за round+games (контракт зафиксирован KS-2884).
  // KS-3263: BroadcastInternalGamesController — резолвер PGN партии
  // по lichess_game_id для AnalysisService.create (api).
  controllers: [BroadcastInternalController, BroadcastInternalGamesController],
  providers: [
    SyncMetricsService,
    BroadcastSyncService,
    BroadcastWatchdogService,
    // KS-3231: cron-метрика «партий в раунде меньше чем у lichess».
    // Опт-ин через env BROADCAST_GAME_COUNT_CHECK_ENABLED=true.
    BroadcastGameCountMetricService,
    // KS-2883 (B10): guard на internal-эндпоинты.
    InternalKeyGuard,
  ],
  exports: [
    BroadcastSyncService,
    BroadcastWatchdogService,
    BroadcastGameCountMetricService,
  ],
})
export class BroadcastSyncModule {}
