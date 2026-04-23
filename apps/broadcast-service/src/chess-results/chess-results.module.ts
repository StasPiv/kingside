import { Module } from '@nestjs/common';
import { ChessResultsFetcher } from './chess-results-fetcher';
import { BroadcastStandingsSyncService } from './broadcast-standings-sync.service';

/**
 * Crosstable-стек для broadcast-service (ADR-023 §2.9.1, KS-1733).
 *
 * Содержит:
 *  - `ChessResultsFetcher` (KS-1728) — HTML-fetcher с rate-limit / circuit-
 *    breaker / retry. Зависит от `RedisService` и `MetricsService` (оба
 *    @Global, доступны из root).
 *  - `BroadcastStandingsSyncService` (KS-1733) — on-demand crosstable-builder.
 *    Использует `ChessResultsFetcher` и parsers из `./parsers/` (чистые
 *    функции, без DI).
 *
 * `MetricsService` и `RedisService` импортируются глобально через
 * `MetricsModule` / `RedisModule` (см. `app.module.ts`); явный import
 * здесь не нужен.
 */
@Module({
  providers: [ChessResultsFetcher, BroadcastStandingsSyncService],
  exports: [ChessResultsFetcher, BroadcastStandingsSyncService],
})
export class ChessResultsModule {}
