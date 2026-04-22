import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type LifecycleStatus = 'live' | 'upcoming' | 'finished';

type BroadcastSummary = {
  id: string;
  lichessId: string;
  title: string;
  status: 'active' | 'finished';
  lifecycleStatus: LifecycleStatus;
  startDate: string | null;
  roundCount: number;
  isPinned: boolean;
  avgElo: number | null;
};

type BroadcastListResponse = {
  data: BroadcastSummary[];
  total: number;
  limit: number;
  offset: number;
};

const LIFECYCLE_VALUES = ['live', 'upcoming', 'finished', 'all'] as const;
type LifecycleFilter = (typeof LIFECYCLE_VALUES)[number];

function parseLifecycleFilter(raw: string | undefined): LifecycleFilter {
  if (!raw) return 'all';
  return (LIFECYCLE_VALUES as readonly string[]).includes(raw)
    ? (raw as LifecycleFilter)
    : 'all';
}

type BroadcastRoundItem = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

type BroadcastRoundsResponse = { data: BroadcastRoundItem[] };

type BroadcastGameItem = {
  id: string;
  lichessGameId: string | null;
  whitePlayer: string | null;
  blackPlayer: string | null;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
  updatedAt: string;
};

type BroadcastGamesResponse = { data: BroadcastGameItem[] };

/**
 * Broadcast HTTP controller (ADR-021 §2.1).
 *
 * Paths (KS-1702 — без префикса `/broadcasts`, хост `broadcasts.kingside.site`
 * уже выражает домен): `/`, `/:id`, `/:id/standings`, `/:id/rounds`,
 * `/:id/rounds/:roundId/games`.
 *
 * Публичные read-only данные — auth не требуется.
 */
// KS-1702 hotfix: `@Get(':id')` матчит любой single-segment путь, включая legacy
// `/broadcasts`, monitoring `/active` и прочий мусор. Без валидации мусор уходит
// в `prisma.broadcast.findUnique({where:{id}})` и Prisma кидает 500 на UUID
// validation. Валидируем параметр как UUID на уровне контроллера и отвечаем 404
// на несоответствие.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new NotFoundException(`${label} ${value} not found`);
  }
}

// KS-1700 Part B: порядок секций live → upcoming → finished.
// Внутри секции:
//  - live: по updatedAt DESC (наиболее свежая обновление первым).
//  - upcoming: по nearestPendingAt ASC (ближайший старт первым),
//    null в конце секции.
//  - finished: по updatedAt DESC.
const LIFECYCLE_ORDER: Record<LifecycleStatus, number> = {
  live: 0,
  upcoming: 1,
  finished: 2,
};

function compareLifecycleSort(
  a: BroadcastSummary & {
    _updatedAt: Date;
    _nearestPendingAt: Date | null;
  },
  b: BroadcastSummary & {
    _updatedAt: Date;
    _nearestPendingAt: Date | null;
  },
): number {
  const orderDiff =
    LIFECYCLE_ORDER[a.lifecycleStatus] - LIFECYCLE_ORDER[b.lifecycleStatus];
  if (orderDiff !== 0) return orderDiff;

  if (a.lifecycleStatus === 'upcoming') {
    const aT = a._nearestPendingAt ? a._nearestPendingAt.getTime() : Infinity;
    const bT = b._nearestPendingAt ? b._nearestPendingAt.getTime() : Infinity;
    if (aT !== bT) return aT - bT;
  }
  // live и finished — по updatedAt DESC
  return b._updatedAt.getTime() - a._updatedAt.getTime();
}

@Controller()
export class BroadcastController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET / — список трансляций с lifecycle-категоризацией (KS-1700 Part B).
   *
   * Query:
   *  - `limit`, `offset` — пагинация (default 20/0, max 100).
   *  - `lifecycle` — фильтр `live|upcoming|finished|all` (default all).
   *
   * Сортировка:
   *  1) live (updatedAt DESC), 2) upcoming (ближайший pending starts_at ASC),
   *  3) finished (updatedAt DESC).
   *
   * Выбираются только `isActive=true` — stale-broadcasts, помеченные worker'ом
   * (KS-1700 Part A), не попадают в выдачу совсем.
   *
   * Пагинация: фильтр + сортировка применяются ДО slice, `total` равен длине
   * отфильтрованного массива (в прод-объёме isActive=true broadcasts <100 это
   * ок; при росте объёма перенести всю логику в SQL с CTE+ROW_NUMBER).
   */
  @Get()
  async getActiveBroadcasts(
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
    @Query('lifecycle') lifecycleParam?: string,
  ): Promise<BroadcastListResponse> {
    const MAX_LIMIT = 100;
    const DEFAULT_LIMIT = 20;

    let limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    if (isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    let offset = offsetParam ? parseInt(offsetParam, 10) : 0;
    if (isNaN(offset) || offset < 0) offset = 0;

    const lifecycle = parseLifecycleFilter(lifecycleParam);

    const broadcasts = await this.prisma.broadcast.findMany({
      where: { isActive: true },
      select: {
        id: true,
        lichessId: true,
        title: true,
        isActive: true,
        startDate: true,
        updatedAt: true,
        _count: { select: { rounds: true } },
      },
    });

    const detailsMap = await this.computeBroadcastDetails(
      broadcasts.map((b) => b.id),
    );

    type Enriched = BroadcastSummary & {
      _updatedAt: Date;
      _nearestPendingAt: Date | null;
    };

    const enriched: Enriched[] = broadcasts.map((b) => {
      const d = detailsMap.get(b.id);
      const lifecycleStatus: LifecycleStatus = d?.lifecycleStatus ?? 'finished';
      return {
        id: b.id,
        lichessId: b.lichessId,
        title: b.title,
        status: b.isActive ? ('active' as const) : ('finished' as const),
        lifecycleStatus,
        startDate: b.startDate?.toISOString() ?? null,
        roundCount: b._count.rounds,
        // isPinned только для live, даже если avgElo/gamesCount проходят порог —
        // finished/upcoming не должны висеть в Featured (см. KS-1700 Part B §2).
        isPinned: lifecycleStatus === 'live' ? (d?.isPinned ?? false) : false,
        avgElo: d?.avgElo ?? null,
        _updatedAt: b.updatedAt,
        _nearestPendingAt: d?.nearestPendingAt ?? null,
      };
    });

    const filtered =
      lifecycle === 'all'
        ? enriched
        : enriched.filter((e) => e.lifecycleStatus === lifecycle);

    const total = filtered.length;

    filtered.sort(compareLifecycleSort);

    const pageSlice = filtered.slice(offset, offset + limit);
    const data: BroadcastSummary[] = pageSlice.map((e) => {
      const { _updatedAt, _nearestPendingAt, ...publicFields } = e;
      void _updatedAt;
      void _nearestPendingAt;
      return publicFields;
    });

    return { data, total, limit, offset };
  }

  /**
   * Вычисляет lifecycleStatus, isPinned, avgElo и nearestPendingAt.
   *
   * lifecycleStatus:
   *  - `live` — есть раунд со `status='ongoing'` ИЛИ `status='pending'` со
   *    `starts_at` в окне [NOW - 1h; NOW + PINNED_UPCOMING_WINDOW_HOURS].
   *  - `upcoming` — не live И есть раунд со `status='pending'`,
   *    `starts_at > NOW + PINNED_UPCOMING_WINDOW_HOURS`.
   *  - `finished` — ни live, ни upcoming (все раунды finished или 0 раундов).
   *
   * isPinned (для клиента проверяется также что lifecycleStatus='live'):
   *  avg_elo >= BROADCAST_PINNED_MIN_ELO (default 2600) AND
   *  elo_games_count >= BROADCAST_PINNED_MIN_GAMES (default 4) AND
   *  есть активный раунд (has_live=true).
   *
   * nearestPendingAt — MIN(starts_at) по pending-раундам с starts_at >= NOW-1h,
   * нужен для сортировки upcoming-секции по ближайшему старту.
   */
  private async computeBroadcastDetails(broadcastIds: string[]): Promise<
    Map<
      string,
      {
        lifecycleStatus: LifecycleStatus;
        isPinned: boolean;
        avgElo: number | null;
        nearestPendingAt: Date | null;
      }
    >
  > {
    const result = new Map<
      string,
      {
        lifecycleStatus: LifecycleStatus;
        isPinned: boolean;
        avgElo: number | null;
        nearestPendingAt: Date | null;
      }
    >();
    if (broadcastIds.length === 0) return result;

    const minElo = parseInt(process.env.BROADCAST_PINNED_MIN_ELO ?? '2600', 10);
    const minGames = parseInt(
      process.env.BROADCAST_PINNED_MIN_GAMES ?? '4',
      10,
    );
    const upcomingWindowHours = parseInt(
      process.env.BROADCAST_PINNED_UPCOMING_HOURS ?? '48',
      10,
    );

    type Row = {
      id: string;
      has_live: boolean;
      has_upcoming: boolean;
      nearest_pending_at: Date | null;
      avg_elo: number | null;
      elo_games_count: number | string;
    };

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT b.id::text as id,
        EXISTS (
          SELECT 1 FROM broadcast_rounds r
          WHERE r.broadcast_id = b.id
            AND (
              r.status = 'ongoing'
              OR (
                r.status = 'pending'
                AND r.starts_at IS NOT NULL
                AND r.starts_at >= NOW() - INTERVAL '1 hour'
                AND r.starts_at <= NOW() + make_interval(hours => ${upcomingWindowHours}::int)
              )
            )
        ) AS has_live,
        EXISTS (
          SELECT 1 FROM broadcast_rounds r
          WHERE r.broadcast_id = b.id
            AND r.status = 'pending'
            AND r.starts_at IS NOT NULL
            AND r.starts_at > NOW() + make_interval(hours => ${upcomingWindowHours}::int)
        ) AS has_upcoming,
        (
          SELECT MIN(r.starts_at)
            FROM broadcast_rounds r
           WHERE r.broadcast_id = b.id
             AND r.status = 'pending'
             AND r.starts_at IS NOT NULL
             AND r.starts_at >= NOW() - INTERVAL '1 hour'
        ) AS nearest_pending_at,
        (
          SELECT AVG(elo_val)::float
          FROM (
            SELECT g.white_elo AS elo_val
              FROM broadcast_games g
              JOIN broadcast_rounds r ON g.round_id = r.id
             WHERE r.broadcast_id = b.id AND g.white_elo IS NOT NULL AND g.white_elo > 0
            UNION ALL
            SELECT g.black_elo
              FROM broadcast_games g
              JOIN broadcast_rounds r ON g.round_id = r.id
             WHERE r.broadcast_id = b.id AND g.black_elo IS NOT NULL AND g.black_elo > 0
          ) t
        ) AS avg_elo,
        (
          SELECT COUNT(*)::int
            FROM broadcast_games g
            JOIN broadcast_rounds r ON g.round_id = r.id
           WHERE r.broadcast_id = b.id
             AND g.white_elo IS NOT NULL AND g.white_elo > 0
             AND g.black_elo IS NOT NULL AND g.black_elo > 0
        ) AS elo_games_count
      FROM broadcasts b
      WHERE b.id::text = ANY(${broadcastIds}::text[])
    `;

    for (const row of rows) {
      const avgElo =
        row.avg_elo !== null && row.avg_elo !== undefined
          ? Math.round(row.avg_elo)
          : null;
      const eloGamesCount = Number(row.elo_games_count);
      const strongField =
        avgElo !== null && avgElo >= minElo && eloGamesCount >= minGames;

      let lifecycleStatus: LifecycleStatus;
      if (row.has_live) lifecycleStatus = 'live';
      else if (row.has_upcoming) lifecycleStatus = 'upcoming';
      else lifecycleStatus = 'finished';

      const isPinned = row.has_live && strongField;

      result.set(row.id, {
        lifecycleStatus,
        isPinned,
        avgElo,
        nearestPendingAt: row.nearest_pending_at
          ? new Date(row.nearest_pending_at)
          : null,
      });
    }

    for (const id of broadcastIds) {
      if (!result.has(id)) {
        result.set(id, {
          lifecycleStatus: 'finished',
          isPinned: false,
          avgElo: null,
          nearestPendingAt: null,
        });
      }
    }

    return result;
  }

  /** GET /:id — метаданные трансляции. */
  @Get(':id')
  async getBroadcast(@Param('id') id: string) {
    assertUuid(id, 'Broadcast');
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
    });
    if (!broadcast) {
      throw new NotFoundException(`Broadcast ${id} not found`);
    }
    return {
      id: broadcast.id,
      lichessId: broadcast.lichessId,
      title: broadcast.title,
      description: broadcast.description,
      url: broadcast.url,
      isActive: broadcast.isActive,
      format: broadcast.format,
      timeControl: broadcast.timeControl,
      location: broadcast.location,
      players: broadcast.players,
      website: broadcast.website,
      standingsUrl: broadcast.standingsUrl,
      imageUrl: broadcast.imageUrl,
      startDate: broadcast.startDate?.toISOString() ?? null,
      endDate: broadcast.endDate?.toISOString() ?? null,
      streams: broadcast.streams,
      createdAt: broadcast.createdAt.toISOString(),
    };
  }

  /** GET /:id/standings — crosstable standings. */
  @Get(':id/standings')
  async getStandings(@Param('id') id: string) {
    assertUuid(id, 'Broadcast');
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
      include: {
        rounds: {
          orderBy: { startsAt: 'asc' },
          include: { games: true },
        },
      },
    });
    if (!broadcast) throw new NotFoundException(`Broadcast ${id} not found`);

    const playerSet = new Set<string>();
    const results: Array<{
      round: string;
      white: string;
      black: string;
      result: string;
      gameId: string;
    }> = [];

    for (const round of broadcast.rounds) {
      for (const game of round.games) {
        const white = game.whitePlayer ?? 'Unknown';
        const black = game.blackPlayer ?? 'Unknown';
        playerSet.add(white);
        playerSet.add(black);
        if (game.result && game.result !== '*') {
          results.push({
            round: round.name,
            white,
            black,
            result: game.result,
            gameId: game.id,
          });
        }
      }
    }

    const playerNames = [...playerSet].sort();

    const points = new Map<string, number>();
    const gamesPlayed = new Map<string, number>();
    const scores = new Map<string, Array<{ score: number; gameId: string }>>();

    for (const name of playerNames) {
      points.set(name, 0);
      gamesPlayed.set(name, 0);
    }

    for (const r of results) {
      gamesPlayed.set(r.white, (gamesPlayed.get(r.white) ?? 0) + 1);
      gamesPlayed.set(r.black, (gamesPlayed.get(r.black) ?? 0) + 1);

      let wp = 0;
      let bp = 0;
      if (r.result === '1-0') {
        wp = 1;
        bp = 0;
      } else if (r.result === '0-1') {
        wp = 0;
        bp = 1;
      } else if (r.result === '1/2-1/2') {
        wp = 0.5;
        bp = 0.5;
      }

      points.set(r.white, (points.get(r.white) ?? 0) + wp);
      points.set(r.black, (points.get(r.black) ?? 0) + bp);

      const wKey = `${r.white}:${r.black}`;
      const bKey = `${r.black}:${r.white}`;
      if (!scores.has(wKey)) scores.set(wKey, []);
      if (!scores.has(bKey)) scores.set(bKey, []);
      scores.get(wKey)!.push({ score: wp, gameId: r.gameId });
      scores.get(bKey)!.push({ score: bp, gameId: r.gameId });
    }

    const sb = new Map<string, number>();
    for (const name of playerNames) {
      let sbScore = 0;
      for (const opp of playerNames) {
        if (opp === name) continue;
        const key = `${name}:${opp}`;
        const ptsFromOpp = scores.get(key) ?? [];
        const oppTotalPts = points.get(opp) ?? 0;
        for (const entry of ptsFromOpp) {
          sbScore += entry.score * oppTotalPts;
        }
      }
      sb.set(name, Math.round(sbScore * 100) / 100);
    }

    const sorted = playerNames.sort(
      (a, b) =>
        (points.get(b) ?? 0) - (points.get(a) ?? 0) ||
        (sb.get(b) ?? 0) - (sb.get(a) ?? 0) ||
        a.localeCompare(b),
    );

    const players = sorted.map((name, i) => ({
      rank: i + 1,
      name,
      points: points.get(name) ?? 0,
      gamesPlayed: gamesPlayed.get(name) ?? 0,
      sb: sb.get(name) ?? 0,
      scores: Object.fromEntries(
        sorted
          .filter((opp) => opp !== name)
          .map((opp) => [opp, scores.get(`${name}:${opp}`) ?? []]),
      ),
    }));

    return { players };
  }

  /** GET /:id/rounds — туры трансляции. */
  @Get(':id/rounds')
  async getBroadcastRounds(
    @Param('id') id: string,
  ): Promise<BroadcastRoundsResponse> {
    assertUuid(id, 'Broadcast');
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
    });
    if (!broadcast) {
      throw new NotFoundException(`Broadcast ${id} not found`);
    }

    const rounds = await this.prisma.broadcastRound.findMany({
      where: { broadcastId: id },
      orderBy: { startsAt: 'asc' },
    });

    const data: BroadcastRoundItem[] = rounds.map((r) => ({
      id: r.id,
      lichessRoundId: r.lichessRoundId,
      name: r.name,
      startsAt: r.startsAt ? r.startsAt.toISOString() : null,
      status: r.status,
    }));

    return { data };
  }

  /** GET /:id/rounds/:roundId/games — партии в туре. */
  @Get(':id/rounds/:roundId/games')
  async getBroadcastRoundGames(
    @Param('id') id: string,
    @Param('roundId') roundId: string,
  ): Promise<BroadcastGamesResponse> {
    assertUuid(id, 'Broadcast');
    assertUuid(roundId, 'Round');
    const round = await this.prisma.broadcastRound.findFirst({
      where: { id: roundId, broadcastId: id },
    });
    if (!round) {
      throw new NotFoundException(
        `Round ${roundId} not found in broadcast ${id}`,
      );
    }

    const games = await this.prisma.broadcastGame.findMany({
      where: { roundId: round.id },
      orderBy: { updatedAt: 'asc' },
    });

    const data: BroadcastGameItem[] = games.map((g) => ({
      id: g.id,
      lichessGameId: g.lichessGameId,
      whitePlayer: g.whitePlayer,
      blackPlayer: g.blackPlayer,
      result: g.result,
      pgn: g.pgn,
      currentFen: g.currentFen,
      updatedAt: g.updatedAt.toISOString(),
    }));

    return { data };
  }
}
