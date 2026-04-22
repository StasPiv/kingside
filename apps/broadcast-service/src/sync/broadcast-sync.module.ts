import { Module } from '@nestjs/common';
import { BroadcastSyncService } from './broadcast-sync.service';
import { SyncMetricsService } from './sync-metrics';

/**
 * Sync-модуль broadcast-service (ADR-022 §2.2).
 *
 * Объединяет логику, перенесённую из `apps/broadcast-worker/src/worker.ts`
 * (sync/pinned-poll/stale-check/pgn-fetch/FEN). HTTP-часть broadcast-service
 * в `http/` не импортит sync-модуль — они изолированы.
 *
 * `PrismaModule`, `RedisModule`, `MetricsModule` — `@Global()`, DI найдёт их
 * автоматически.
 */
@Module({
  providers: [SyncMetricsService, BroadcastSyncService],
  exports: [BroadcastSyncService],
})
export class BroadcastSyncModule {}
