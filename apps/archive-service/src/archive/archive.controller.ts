import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import type {
  ArchiveGameDetail,
  ArchiveGamesByPositionResponse,
  ArchiveGamesResponse,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveService } from './archive.service';
import { ArchiveTreeQueryDto } from './dto/archive-tree-query.dto';
import { ArchiveGamesQueryDto } from './dto/archive-games-query.dto';
import { ArchiveGamesByPositionQueryDto } from './dto/archive-games-by-position-query.dto';

/**
 * KS-1690: все read-эндпоинты отдают `Cache-Control: no-cache, must-revalidate`.
 *
 * Без явного `Cache-Control` браузеры применяют heuristic freshness
 * (RFC 7234 §4.2.2) и могут держать ответ в HTTP-кэше неопределённо
 * долго — это проявилось в KS-1689 как stale-бейдж «based on N games»
 * при реальном другом totalGames в БД.
 *
 * `no-cache` — требует revalidate при каждом обращении; тело всё ещё
 * сохраняется в кэше и переиспользуется после 304 от сервера.
 * `must-revalidate` — запрещает отдавать stale, если revalidate не
 * прошёл (не-2xx / offline) — защита от «молчаливо устаревшего» UI.
 *
 * ETag Express добавляет сам; 304 revalidation работает как раньше
 * (KS-1689 pre-check подтвердил). Регрессия проверена e2e-спеком
 * `archive-cache-control.e2e.spec.ts`.
 */
const CACHE_CONTROL_REVALIDATE = 'no-cache, must-revalidate';

@Controller()
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Get('tree')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  getTree(@Query() query: ArchiveTreeQueryDto): Promise<ArchiveTreeResponse> {
    return this.archive.getTree(query);
  }

  /**
   * Games-by-position — keyset-paginated list of games that reached a
   * given position. See ADR-014 §2, §4.1.
   *
   * Declared BEFORE `games/:id` so Nest routes `by-position` as a
   * literal path segment, not a `:id` match.
   */
  @Get('games/by-position')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  getGamesByPosition(
    @Query() query: ArchiveGamesByPositionQueryDto,
  ): Promise<ArchiveGamesByPositionResponse> {
    return this.archive.getGamesByPosition(query);
  }

  @Get('games/:id')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  getGame(@Param('id') id: string): Promise<ArchiveGameDetail> {
    return this.archive.getGameById(id);
  }

  @Get('games')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  getGames(@Query() query: ArchiveGamesQueryDto): Promise<ArchiveGamesResponse> {
    return this.archive.getGames(query);
  }
}
