/**
 * KS-2883 / ADR-060 §3.7 B10. Internal-эндпоинты broadcast-service'а.
 *
 * Контракт зафиксирован в `apps/api/src/study/broadcast/broadcast-service.client.ts`
 * (KS-2884):
 *   GET /internal/rounds/:roundId/with-games
 *   Header: X-Internal-Auth: <SYNTHETIC_BOT_INTERNAL_KEY>
 *   Response 200: { round: {id, name}, games: BroadcastGameDto[] }
 *   404: round не найден.
 *
 * Используется api для:
 *   - `POST /api/studies/from-broadcast-round` (создание зеркала);
 *   - `POST /api/studies/sync-broadcast-round` (idempotent sync PGN).
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalKeyGuard } from './internal-key.guard';

export interface InternalRoundWithGames {
  round: { id: string; name: string };
  games: Array<{
    id: string;
    pgn: string;
    whitePlayer: string | null;
    blackPlayer: string | null;
    result: string | null;
  }>;
}

@Controller('internal/rounds')
@UseGuards(InternalKeyGuard)
export class BroadcastInternalController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':roundId/with-games')
  async getRoundWithGames(
    @Param('roundId', ParseUUIDPipe) roundId: string,
  ): Promise<InternalRoundWithGames> {
    const round = await this.prisma.broadcastRound.findUnique({
      where: { id: roundId },
      select: { id: true, name: true },
    });
    if (!round) {
      throw new NotFoundException(`Broadcast round ${roundId} not found`);
    }
    const games = await this.prisma.broadcastGame.findMany({
      where: { roundId },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        pgn: true,
        whitePlayer: true,
        blackPlayer: true,
        result: true,
      },
    });
    return {
      round,
      games: games.map((g) => ({
        id: g.id,
        // null pgn → пустая строка (api ожидает строку, нормализуем здесь).
        pgn: g.pgn ?? '',
        whitePlayer: g.whitePlayer,
        blackPlayer: g.blackPlayer,
        result: g.result,
      })),
    };
  }
}
