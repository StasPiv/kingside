import { Module } from '@nestjs/common';
import { BroadcastSyncService } from './broadcast-sync.service';
import { SyncMetricsService } from './sync-metrics';
import { BroadcastWatchdogService } from './broadcast-watchdog.service';

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
  providers: [SyncMetricsService, BroadcastSyncService, BroadcastWatchdogService],
  exports: [BroadcastSyncService, BroadcastWatchdogService],
})
export class BroadcastSyncModule {}
