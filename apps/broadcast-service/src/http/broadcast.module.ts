import { Module } from '@nestjs/common';
import { BroadcastController } from './broadcast.controller';
import { BroadcastGateway } from './broadcast.gateway';
import { ChessResultsModule } from '../chess-results/chess-results.module';

/**
 * Lichess broadcasts — HTTP + WS (ADR-021 §2.1/§2.3).
 *
 * Переехал из `apps/api/src/broadcast/` в `apps/broadcast-service/src/http/`
 * (ADR-022 §2.2). Зависит от `@kingside/broadcasts-db` (Prisma client с
 * `BROADCASTS_DATABASE_URL`) и от `RedisService` (подписка на
 * `broadcast:move` / `broadcast:sync`, куда пишет sync-loop
 * `BroadcastSyncService`).
 *
 * ChessResultsService / LivechesscloudService / LiveTournament **не здесь** —
 * они про `chess-results.com` / `view.livechesscloud.com`, это отдельный
 * продуктовый домен. Оставлены в `apps/api/src/live-tournament/` (B2').
 */
@Module({
  imports: [ChessResultsModule],
  controllers: [BroadcastController],
  providers: [BroadcastGateway],
})
export class BroadcastModule {}
