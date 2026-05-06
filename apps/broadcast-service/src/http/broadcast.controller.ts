import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import type {
  BracketLink,
  BroadcastBracketResponse,
  BroadcastGameSummary,
  BroadcastGamesResponse,
  BroadcastRoundItem,
  BroadcastRoundTournamentType,
  CrosstableResponse,
} from '@kingside/shared';
import { computeAdvanceLinks } from '../crosstable/compute-advance-links';

type LifecycleStatus = 'live' | 'upcoming' | 'finished';

type TopPlayer = { name: string; elo: number };

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
  topPlayers: TopPlayer[];
};

/**
 * KS-2450. Билдер top-3 игроков турнира.
 *
 * Дедуп по `name`: если у игрока встретилось несколько разных elo —
 * берём **максимальный** (комментарий выбора зафиксирован: top показывает
 * пиковую силу состава, не среднюю/последнюю).
 * Сортировка: `elo DESC`, при равенстве — `name ASC` (стабильный
 * локализационно-нейтральный tie-break).
 * Игнорируем записи с пустым/отсутствующим именем или elo ≤ 0.
 *
 * Чистая функция — переиспользуется и в тестах, и в HTTP-обработчике.
 */
export function buildTopPlayers(
  raw: ReadonlyArray<{ name: string | null; elo: number | null }>,
  limit = 3,
): TopPlayer[] {
  const byName = new Map<string, number>();
  for (const p of raw) {
    const name = p.name?.trim();
    if (!name) continue;
    if (p.elo == null || p.elo <= 0) continue;
    const existing = byName.get(name);
    if (existing === undefined || p.elo > existing) byName.set(name, p.elo);
  }
  return Array.from(byName.entries())
    .map(([name, elo]) => ({ name, elo }))
    .sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name))
    .slice(0, limit);
}

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

type BroadcastRoundsResponse = { data: BroadcastRoundItem[] };

const ROUND_TOURNAMENT_TYPES: readonly BroadcastRoundTournamentType[] = [
  'round_robin',
  'swiss',
  'playoff',
  'unknown',
];

function normalizeRoundTournamentType(
  raw: string | null,
): BroadcastRoundTournamentType | null {
  if (raw === null || raw === undefined) return null;
  return (ROUND_TOURNAMENT_TYPES as readonly string[]).includes(raw)
    ? (raw as BroadcastRoundTournamentType)
    : 'unknown';
}

/**
 * Исходная FEN стартовой позиции (KS-2213).
 * Партия без ходов имеет `currentFen = STARTING_FEN` — это сигнал placeholder-а.
 */
const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type GameRow = {
  id: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  result: string | null;
  currentFen: string | null;
  updatedAt: Date;
  [key: string]: unknown;
};

/**
 * Дедупликация партий тура (KS-2213).
 *
 * Lichess создаёт placeholder-записи за день до раунда (result="*", FEN
 * стартовая), а затем новые записи с реальными lichessGameId. В итоге одна
 * пара (white+black) встречается ≥ 2 раз. Оставляем по одной — «лучшей» —
 * записи на пару.
 *
 * Приоритет выбора:
 *   1. result ≠ "*" > result = "*"   (есть результат → реальная партия)
 *   2. FEN ≠ STARTING_FEN > STARTING_FEN  (есть ходы)
 *   3. более позднее updatedAt         (более свежая запись)
 *
 * Партии без whitePlayer/blackPlayer (не-стандартные записи) не трогаем —
 * пропускаем через without deduplication.
 */
export function deduplicateGamesByPair<T extends GameRow>(games: T[]): T[] {
  const byPair = new Map<string, T>();
  const noPair: T[] = [];

  for (const g of games) {
    const w = (g.whitePlayer ?? '').trim().toLowerCase();
    const b = (g.blackPlayer ?? '').trim().toLowerCase();
    if (!w || !b) {
      noPair.push(g);
      continue;
    }
    const key = w <= b ? `${w}|${b}` : `${b}|${w}`;
    const existing = byPair.get(key);
    if (!existing || isBetterGame(g, existing)) {
      byPair.set(key, g);
    }
  }

  return [...byPair.values(), ...noPair];
}

function isBetterGame<T extends GameRow>(candidate: T, current: T): boolean {
  const candHasResult = candidate.result !== '*' && candidate.result !== null;
  const currHasResult = current.result !== '*' && current.result !== null;
  if (candHasResult !== currHasResult) return candHasResult;

  const candHasMoves = candidate.currentFen !== STARTING_FEN;
  const currHasMoves = current.currentFen !== STARTING_FEN;
  if (candHasMoves !== currHasMoves) return candHasMoves;

  return candidate.updatedAt > current.updatedAt;
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly standingsSync: BroadcastStandingsSyncService,
  ) {}

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
   * Stale-broadcasts (KS-1700 Part A: после N циклов отсутствия в Lichess
   * top-20 worker помечает `isActive=false`) **возвращаются в выдачу** как
   * `lifecycleStatus='finished'` — KS-1746: пользователь хочет видеть архив,
   * по ADR-021 записи хранятся всегда. `compareLifecycleSort` укладывает
   * finished в конец, не мешая live/upcoming.
   *
   * Пагинация: фильтр + сортировка применяются ДО slice, `total` равен длине
   * отфильтрованного массива. На прод-объёме (десятки активных + сотни
   * архивных) пагинация по 20 default'у держит payload в норме; при росте
   * до тысяч — перенести всю логику в SQL с CTE+ROW_NUMBER.
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

    // KS-1746: фильтр `where: { isActive: true }` снят — стейл-трансляции
    // видны в категории finished.
    // KS-2207: скрываем трансляции с суммарно 0 партий — они засоряют раздел
    // (пустые страницы без игр).
    const broadcasts = await this.prisma.broadcast.findMany({
      where: {
        rounds: { some: { games: { some: {} } } },
      },
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

    const ids = broadcasts.map((b) => b.id);
    const [detailsMap, topPlayersMap] = await Promise.all([
      this.computeBroadcastDetails(ids),
      this.computeTopPlayers(ids),
    ]);

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
        topPlayers: topPlayersMap.get(b.id) ?? [],
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
   *  1. `finished` (приоритет) — `end_date IS NOT NULL AND end_date < NOW()`.
   *     Это надёжный сигнал от Lichess API; не зависит от актуальности
   *     round-статусов (sync может отставать при сбоях).
   *  2. `upcoming` — `end_date` ещё не прошёл (или нет) И первый тур
   *     ещё не начался (starts_at > NOW() И status != 'ongoing').
   *  3. `live` — иначе: первый тур начался, end_date не прошёл.
   *
   * Порядок туров: по starts_at ASC NULLS LAST.
   * Нет раундов → finished.
   *
   * isPinned (для клиента проверяется также что lifecycleStatus='live'):
   *  avg_elo >= BROADCAST_PINNED_MIN_ELO (default 2600) AND
   *  elo_games_count >= BROADCAST_PINNED_MIN_GAMES (default 4).
   *
   * nearestPendingAt — MIN(starts_at) по будущим раундам (starts_at > NOW()),
   * используется только для сортировки upcoming-секции.
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

    type Row = {
      id: string;
      end_date_passed: boolean;
      first_round_started: boolean;
      nearest_pending_at: Date | null;
      avg_elo: number | null;
      elo_games_count: number | string;
    };

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT b.id::text as id,
        -- end_date прошёл → турнир завершён (надёжный сигнал от Lichess)
        (b.end_date IS NOT NULL AND b.end_date < NOW()) AS end_date_passed,
        -- Первый тур (по starts_at ASC) начался: starts_at <= NOW() или ongoing
        COALESCE((
          SELECT (r.starts_at IS NOT NULL AND r.starts_at <= NOW())
                 OR r.status = 'ongoing'
            FROM broadcast_rounds r
           WHERE r.broadcast_id = b.id
           ORDER BY r.starts_at ASC NULLS LAST
           LIMIT 1
        ), FALSE) AS first_round_started,
        -- MIN starts_at будущих раундов — только для сортировки upcoming
        (
          SELECT MIN(r.starts_at)
            FROM broadcast_rounds r
           WHERE r.broadcast_id = b.id
             AND r.starts_at IS NOT NULL
             AND r.starts_at > NOW()
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
      if (row.end_date_passed) lifecycleStatus = 'finished';
      else if (!row.first_round_started) lifecycleStatus = 'upcoming';
      else lifecycleStatus = 'live';

      const isPinned = lifecycleStatus === 'live' && strongField;

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

  /**
   * KS-2450. Top-3 игроков по elo для каждого id (батчем, без N+1).
   *
   * SQL: один UNION ALL по white/black из всех партий всех туров каждого
   * запрошенного броадкаста, фильтр по `broadcastIds`. JS-агрегация
   * (`buildTopPlayers`) на стороне сервиса — для тестируемости и чтобы
   * не плодить громоздкий SQL с window-функциями.
   *
   * Объёмы: 67 турниров × ~50 пар × 2 стороны = ~6700 строк max — не
   * требует кеша. Если корпус вырастет — заворачивать в Redis-cache 60-120s
   * по ключу `broadcasts:topPlayers:<id>` (см. KS-2450 описание).
   */
  private async computeTopPlayers(
    broadcastIds: string[],
  ): Promise<Map<string, TopPlayer[]>> {
    const result = new Map<string, TopPlayer[]>();
    if (broadcastIds.length === 0) return result;

    type Row = {
      broadcast_id: string;
      name: string | null;
      elo: number | null;
    };

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT r.broadcast_id::text AS broadcast_id,
             g.white_player AS name,
             g.white_elo AS elo
        FROM broadcast_games g
        JOIN broadcast_rounds r ON g.round_id = r.id
       WHERE r.broadcast_id::text = ANY(${broadcastIds}::text[])
         AND g.white_player IS NOT NULL
         AND g.white_elo IS NOT NULL
         AND g.white_elo > 0
      UNION ALL
      SELECT r.broadcast_id::text AS broadcast_id,
             g.black_player AS name,
             g.black_elo AS elo
        FROM broadcast_games g
        JOIN broadcast_rounds r ON g.round_id = r.id
       WHERE r.broadcast_id::text = ANY(${broadcastIds}::text[])
         AND g.black_player IS NOT NULL
         AND g.black_elo IS NOT NULL
         AND g.black_elo > 0
    `;

    const byBroadcast = new Map<
      string,
      Array<{ name: string | null; elo: number | null }>
    >();
    for (const row of rows) {
      let arr = byBroadcast.get(row.broadcast_id);
      if (!arr) {
        arr = [];
        byBroadcast.set(row.broadcast_id, arr);
      }
      arr.push({ name: row.name, elo: row.elo });
    }

    for (const id of broadcastIds) {
      const raw = byBroadcast.get(id) ?? [];
      result.set(id, buildTopPlayers(raw));
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

  /**
   * GET /:id/crosstable — type-aware crosstable (KS-1734, ADR-023 §2.8).
   *
   * Делегирует в `BroadcastStandingsSyncService.getFresh` (KS-1733):
   * свежий кэш → отдаём моментально; устаревший → отдаём + триггерим
   * async refresh; нет кэша → синхронный fetch+parse под Redis-lock.
   *
   * Cache-Control: `public, max-age=30, stale-while-revalidate=60` —
   * фронт и CloudFront уважают, инвалидация при upsert не нужна (срок
   * короткий).
   *
   * Public, без auth (как `/broadcasts/:id`).
   *
   * Старый `/:id/standings` остаётся на soak-период по ADR-023 §2.4 —
   * фронт мигрирует на `/crosstable`, через 2 недели `/standings`
   * удаляется.
   */
  @Get(':id/crosstable')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async getCrosstable(@Param('id') id: string): Promise<CrosstableResponse> {
    assertUuid(id, 'Broadcast');
    try {
      return await this.standingsSync.getFresh(id);
    } catch (err: unknown) {
      // sync-service бросает только для `broadcast not found` — остальные
      // ошибки fetcher/parser обёрнуты в legacy-fallback внутри сервиса.
      const msg = (err as Error).message;
      if (/not found/i.test(msg)) {
        throw new NotFoundException(`Broadcast ${id} not found`);
      }
      throw err;
    }
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
      // KS-1813: null → фронт рендерит как legacy; сохранённое значение
      // проходит whitelist, неизвестное сводится к 'unknown'.
      tournamentType: normalizeRoundTournamentType(r.tournamentType),
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

    const rawGames = await this.prisma.broadcastGame.findMany({
      where: { roundId: round.id },
      orderBy: { updatedAt: 'asc' },
    });

    // KS-2213: убираем Lichess placeholder-дубликаты — оставляем по одной
    // «лучшей» записи на пару (white+black).
    const games = deduplicateGamesByPair(rawGames);

    const data: BroadcastGameSummary[] = games.map((g) => ({
      id: g.id,
      lichessGameId: g.lichessGameId,
      whitePlayer: g.whitePlayer,
      blackPlayer: g.blackPlayer,
      whiteElo: g.whiteElo,
      blackElo: g.blackElo,
      result: g.result,
      pgn: g.pgn,
      currentFen: g.currentFen,
      updatedAt: g.updatedAt.toISOString(),
      // KS-1813: bracket-поля заполнены только для playoff-раундов;
      // для round-robin / swiss / unknown возвращаются как null.
      bracketStage: g.bracketStage,
      bracketPairId: g.bracketPairId,
      matchScore: g.matchScore,
    }));

    return { data };
  }

  /**
   * GET /:id/bracket — агрегированный ответ для фронт-сетки плей-офф
   * (KS-1824). Возвращает все партии всех playoff-раундов броадкаста
   * с заполненными bracket-полями. Для не-playoff броадкастов —
   * пустой `games[]` (контракт: фронт рендерит свой crosstable, а
   * bracket-endpoint явно сообщает «сетки нет»).
   *
   * Cache-Control — тот же, что у `/crosstable`: короткое окно, чтобы
   * live-обновления Standings не били напрямую в БД, но и не отставали
   * сильно от реальной картины.
   */
  @Get(':id/bracket')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async getBroadcastBracket(
    @Param('id') id: string,
  ): Promise<BroadcastBracketResponse> {
    assertUuid(id, 'Broadcast');
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!broadcast) {
      throw new NotFoundException(`Broadcast ${id} not found`);
    }

    // Тянем раунды + их игры одним запросом. Для не-playoff раундов
    // игры не нужны — но фильтровать на уровне Prisma join'а неудобно,
    // поэтому фильтруем уже в памяти. Объёмы скромные (десятки раундов,
    // сотни партий максимум).
    const rounds = await this.prisma.broadcastRound.findMany({
      where: { broadcastId: broadcast.id },
      orderBy: { startsAt: 'asc' },
      include: {
        games: { orderBy: { updatedAt: 'asc' } },
      },
    });

    const roundTypes = rounds.map((r) =>
      normalizeRoundTournamentType(r.tournamentType),
    );
    const hasPlayoff = roundTypes.some((t) => t === 'playoff');

    let tournamentType: BroadcastRoundTournamentType | null;
    let games: BroadcastGameSummary[];
    let links: BracketLink[] = [];
    if (hasPlayoff) {
      tournamentType = 'playoff';
      // Берём только партии playoff-раундов — гибридные турниры
      // (Swiss → Playoffs) отдадут только knockout-часть.
      const playoffGamesRaw = rounds
        .filter(
          (r) => normalizeRoundTournamentType(r.tournamentType) === 'playoff',
        )
        .flatMap((r) => r.games);
      games = playoffGamesRaw.map(
        (g): BroadcastGameSummary => ({
          id: g.id,
          lichessGameId: g.lichessGameId,
          whitePlayer: g.whitePlayer,
          blackPlayer: g.blackPlayer,
          whiteElo: g.whiteElo,
          blackElo: g.blackElo,
          result: g.result,
          pgn: g.pgn,
          currentFen: g.currentFen,
          updatedAt: g.updatedAt.toISOString(),
          bracketStage: g.bracketStage,
          bracketPairId: g.bracketPairId,
          matchScore: g.matchScore,
          advanceToPairId: g.advanceToPairId,
          loserToPairId: g.loserToPairId,
        }),
      );

      // Дедуплицированные рёбра — вычисляем заново по уникальным парам,
      // не полагаясь на то, что sync-цикл уже записал advance/loser в БД
      // (для свежих раундов запрос может прилететь раньше ближайшего
      // sync-цикла). `computeAdvanceLinks` идемпотентен и быстр.
      const pairs = playoffGamesRaw
        .filter(
          (g): g is typeof g & { bracketPairId: string; bracketStage: string } =>
            g.bracketPairId !== null && g.bracketStage !== null,
        )
        .map((g) => ({
          bracketPairId: g.bracketPairId,
          bracketStage: g.bracketStage,
        }));
      links = computeAdvanceLinks(pairs).links;
    } else {
      // Нет playoff-раундов → возвращаем первый не-null тип (обычно он
      // общий для всех раундов), иначе null. Клиент трактует null как
      // 'unknown' (sync ещё не прошёл после KS-1813).
      tournamentType = roundTypes.find((t) => t !== null) ?? null;
      games = [];
      links = [];
    }

    return {
      broadcastId: broadcast.id,
      tournamentType,
      games,
      links,
    };
  }
}
