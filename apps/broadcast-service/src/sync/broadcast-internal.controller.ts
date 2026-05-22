/**
 * KS-2883 / ADR-060 §3.7 B10. Internal-эндпоинты broadcast-service'а.
 *
 * Контракт:
 *   GET /internal/rounds/:roundId/with-games
 *   Header: X-Internal-Auth: <SYNTHETIC_BOT_INTERNAL_KEY>
 *   Response 200: { round: {id, name}, games: BroadcastGameDto[] }
 *   404: round не найден.
 *
 * KS-3128 / ADR-067: ранее эндпоинт использовался для зеркала Studies
 * (от api → broadcast-service за round+games). Модуль Studies удалён,
 * клиентских вызовов сейчас нет; контроллер оставлен как
 * generic-эндпоинт за round/games для возможных будущих внутренних
 * интеграций.
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalKeyGuard } from './internal-key.guard';
import { BroadcastSyncService } from './broadcast-sync.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: BroadcastSyncService,
  ) {}

  /**
   * KS-3254. Принудительный re-sync раунда — для одноразового
   * устранения legacy-расхождений после KS-3229 (broken-записи из-за
   * Site=URL split-bug в parsePgnGames). Не нужен в обычной эксплуатации:
   * автополлинг подхватит новые ходы сам. Но для раундов где у нас
   * было сохранено меньше партий из-за бага парсера, обычный поллинг
   * НЕ дотягивает (skip по pgn-hash / cooldown / total>0).
   *
   * Принимает lichess_round_id (Base62-id из Lichess), не наш UUID,
   * — потому что наша БД индексирована по lichess_round_id для PGN-poll'а.
   */
  @Post(':lichessRoundId/force-resync')
  async forceResync(
    @Param('lichessRoundId') lichessRoundId: string,
  ): Promise<{ fetched: boolean; gamesBefore: number; gamesAfter: number }> {
    if (!/^[A-Za-z0-9]+$/.test(lichessRoundId) || lichessRoundId.length > 16) {
      throw new NotFoundException(
        `Invalid lichessRoundId format: ${lichessRoundId}`,
      );
    }
    return this.syncService.forceResyncRound(lichessRoundId);
  }

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
