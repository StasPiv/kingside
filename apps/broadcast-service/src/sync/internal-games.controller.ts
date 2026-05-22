/**
 * KS-3263. Internal-endpoint резолвера PGN партии broadcast'а по
 * `lichess_game_id`. Используется api-сервисом, чтобы при POST /analyses
 * с `{lichessGameId}` (без PGN) подтянуть текст партии напрямую из
 * нашей БД broadcast'ов, не прокидывая его через фронт.
 *
 * Контракт:
 *   GET /internal/games/by-lichess/:lichessGameId
 *   Header: X-Internal-Auth: <SYNTHETIC_BOT_INTERNAL_KEY>
 *   200 → { id, lichessGameId, pgn, whitePlayer, blackPlayer, whiteElo,
 *           blackElo, result, currentFen, roundId, broadcastId }
 *   404 → партия с таким lichess_game_id не найдена.
 *
 * Один и тот же lichess_game_id у нас уникален в рамках раунда (KS-3229
 * `[GameURL]`-based hash), но теоретически может встречаться в разных
 * раундах с одинаковым id. На практике Lichess game-id'ы детерминированы
 * по партии и совпадение между разными broadcast'ами не встречается.
 * findFirst c ORDER BY updated_at DESC — возвращаем самый свежий
 * (на случай теоретического коллидинга при копировании раундов).
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalKeyGuard } from './internal-key.guard';

export interface InternalGameByLichess {
  id: string;
  lichessGameId: string;
  pgn: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  result: string | null;
  currentFen: string | null;
  roundId: string;
  broadcastId: string;
}

@Controller('internal/games')
@UseGuards(InternalKeyGuard)
export class BroadcastInternalGamesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('by-lichess/:lichessGameId')
  async getByLichessId(
    @Param('lichessGameId') lichessGameId: string,
  ): Promise<InternalGameByLichess> {
    // Lichess game-id — Base62, обычно 8 символов. Лимит 16 — защита
    // от мусора в URL.
    if (!/^[A-Za-z0-9]+$/.test(lichessGameId) || lichessGameId.length > 16) {
      throw new NotFoundException(
        `Invalid lichessGameId format: ${lichessGameId}`,
      );
    }
    const game = await this.prisma.broadcastGame.findFirst({
      where: { lichessGameId },
      orderBy: { updatedAt: 'desc' },
      include: {
        round: { select: { id: true, broadcastId: true } },
      },
    });
    if (!game) {
      throw new NotFoundException(
        `Broadcast game ${lichessGameId} not found`,
      );
    }
    return {
      id: game.id,
      lichessGameId: lichessGameId,
      pgn: game.pgn ?? '',
      whitePlayer: game.whitePlayer,
      blackPlayer: game.blackPlayer,
      whiteElo: game.whiteElo,
      blackElo: game.blackElo,
      result: game.result,
      currentFen: game.currentFen ?? null,
      roundId: game.round.id,
      broadcastId: game.round.broadcastId,
    };
  }
}
