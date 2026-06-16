import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import type {
  ArchiveEventSearchResponse,
  ArchiveGameDetail,
  ArchiveGamesByPositionResponse,
  ArchiveGamesResponse,
  ArchivePlayerGamesResponse,
  ArchivePlayerProfileResponse,
  ArchivePlayerSearchResponse,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveService } from './archive.service';
import { ArchiveTreeQueryDto } from './dto/archive-tree-query.dto';
import { ArchiveGamesQueryDto } from './dto/archive-games-query.dto';
import { ArchiveGamesByPositionQueryDto } from './dto/archive-games-by-position-query.dto';
import { ArchivePlayersSearchQueryDto } from './dto/archive-players-search-query.dto';
import { ArchiveEventsSearchQueryDto } from './dto/archive-events-search-query.dto';
import { ArchivePlayerGamesQueryDto } from './dto/archive-player-games-query.dto';

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

/**
 * KS-4247 / ADR-131. `@Controller('archive')` — обязательный префикс:
 * в apps/api уже есть `@Controller('games')` и `@Controller('players')`,
 * на корневых путях NestJS RouterExplorer бросит дубль (ADR-131 §2.5).
 *
 * Маппинг `archive.kingside.site/{path}` → `api.kingside.site/archive/{path}`
 * делает CloudFront/ALB path-rewrite (задача A2).
 */
@Controller('archive')
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

  // ─── Players & events (KS-2065 / ADR-033 §6.3) ───────────────────

  /**
   * Players autocomplete via FTS (pg_trgm).
   * Маршрут объявлен ДО `players/:slug`, чтобы NestJS не сматчил
   * `search` как параметр slug.
   */
  @Get('players/search')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  searchPlayers(
    @Query() query: ArchivePlayersSearchQueryDto,
  ): Promise<ArchivePlayerSearchResponse> {
    return this.archive.searchPlayers(query);
  }

  /**
   * Player profile (MV `archive_player_stats`). 404 если slug не найден.
   * Маршрут `players/:slug/games` объявлен ДО `players/:slug`, чтобы
   * NestJS не сматчил `:slug` как `slug/games`.
   */
  @Get('players/:slug/games')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  getPlayerGames(
    @Param('slug') slug: string,
    @Query() query: ArchivePlayerGamesQueryDto,
  ): Promise<ArchivePlayerGamesResponse> {
    return this.archive.getPlayerGames(slug, query);
  }

  @Get('players/:slug')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  getPlayerProfile(
    @Param('slug') slug: string,
  ): Promise<ArchivePlayerProfileResponse> {
    return this.archive.getPlayerProfile(slug);
  }

  @Get('events/search')
  @Header('Cache-Control', CACHE_CONTROL_REVALIDATE)
  searchEvents(
    @Query() query: ArchiveEventsSearchQueryDto,
  ): Promise<ArchiveEventSearchResponse> {
    return this.archive.searchEvents(query);
  }
}
