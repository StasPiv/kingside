import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  ChessResultsFetcher,
  CircuitOpenError,
  HttpThrottleError,
  RateLimitedLocalError,
  type Lifecycle,
} from './chess-results-fetcher';
import {
  detectTournamentType,
  type DetectInput,
} from '../crosstable/detect-tournament-type';
import {
  composeGameRefs,
  normalizePlayerName,
  type BroadcastGameInput,
  type BroadcastRoundInput,
  type MatcherMetrics,
} from '../crosstable/player-matcher';
import { parseRrCrosstable } from './parsers/parse-rr-crosstable';
import { parseSwissRanking } from './parsers/parse-swiss-ranking';
import { parseSwissPairings } from './parsers/parse-swiss-pairings';
import { parseTeamStandings } from './parsers/parse-team-standings';
import { parseTeamComposition } from './parsers/parse-team-composition';
import { parseTeamPairings } from './parsers/parse-team-pairings';
import type {
  CrosstableResponse,
  CrosstableLegacy,
  CrosstableRoundRobin,
  CrosstableSwiss,
  CrosstableTeam,
  CrosstablePlayer,
  CrosstableCell,
  TournamentType,
} from '@kingside/shared';

/**
 * On-demand crosstable-builder для broadcasts (KS-1733, ADR-023 §2.7-§2.8).
 *
 * Обеспечивает single entry-point `getFresh(broadcastId)` для endpoint'а
 * `GET /broadcasts/:id/crosstable` (A10). Алгоритм:
 *
 *   1. Читаем `BroadcastStandings` из БД.
 *   2. Если запись свежая (`stale_at > now()`) — отдаём её сразу
 *      (materialize JSON → CrosstableResponse).
 *   3. Если запись устарела — возвращаем устаревшую и **fire-and-forget**
 *      триггерим `refresh` (фронт получает что-то моментально, а на
 *      следующем запросе будет уже свежее).
 *   4. Если записи нет вовсе — synchronous `refresh` под Redis-lock
 *      `broadcast:standings:lock:<id>` (TTL 30 с) для dedup'а параллельных
 *      запросов. Если lock занят, кратко poll'им БД на появление новой
 *      записи; если не дождались — fall through на свой fetch.
 *
 * `refresh(broadcastId)` собирает финальный `CrosstableResponse`:
 *   1. `detectTournamentType` (KS-1727) по `Broadcast.format` + `teamTable`.
 *   2. `Broadcast.chessResultsTournamentId` — есть ли у нас id chess-results.
 *   3. Если нет id или type='unknown' — `CrosstableLegacy` из
 *      `broadcast_games` (legacy-fallback, не ломает текущее поведение).
 *   4. Иначе fetch + парсинг + матчинг (per type, см. `build*` методы).
 *      При любой ошибке fetch/парсера — fallback на legacy.
 *   5. Persist в `broadcast_standings` + метрика
 *      `broadcast_standings_refresh_total{status,type}`.
 *
 * **Rate-limit per art** уже встроен в `ChessResultsFetcher` (KS-1728);
 * если fetcher бросает `RateLimitedLocalError` — это сигнал что мы только
 * что fetched, не пытаемся снова (используем устаревшую запись из БД, а
 * если её нет — отдаём legacy + reason).
 */

const TTL_MS_BY_LIFECYCLE: Record<Lifecycle, number> = {
  live: 5 * 60 * 1000,
  upcoming: 60 * 60 * 1000,
  finished: 24 * 60 * 60 * 1000,
};

const REFRESH_LOCK_KEY_PREFIX = 'broadcast:standings:lock';
const REFRESH_LOCK_TTL_SEC = 30;
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 10;

const SOURCE_URL_TPL = (tid: string): string =>
  `https://chess-results.com/tnr${tid}.aspx`;

export interface SyncDeps {
  /** Источник «текущего времени» для тестов. */
  now?: () => number;
  /** sleep для тестов (jest fake timers ломает наш async-flow, см. KS-1728). */
  sleep?: (ms: number) => Promise<void>;
}

@Injectable()
export class BroadcastStandingsSyncService {
  private readonly logger = new Logger(BroadcastStandingsSyncService.name);
  private readonly refreshTotal: Counter<'status' | 'type'>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly fetcher: ChessResultsFetcher,
    metrics: MetricsService,
    @Optional()
    @Inject('BROADCAST_STANDINGS_SYNC_DEPS')
    deps?: SyncDeps,
  ) {
    const d = deps ?? {};
    this.now = d.now ?? (() => Date.now());
    this.sleep =
      d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.refreshTotal = new Counter({
      name: 'broadcast_standings_refresh_total',
      help: 'Refresh-операции BroadcastStandingsSyncService по статусу и типу турнира.',
      labelNames: ['status', 'type'] as const,
      registers: [metrics.registry],
    });
  }

  /**
   * Главный entry-point. Возвращает свежий или устаревший (с триггером
   * async refresh) CrosstableResponse. Всегда что-то возвращает; если
   * ничего нельзя получить, бросает Error (caller — A10 — оборачивает в HTTP).
   */
  async getFresh(broadcastId: string): Promise<CrosstableResponse> {
    const cached = await this.prisma.broadcastStandings.findUnique({
      where: { broadcastId },
    });
    const nowMs = this.now();

    if (cached) {
      const isFresh = cached.staleAt.getTime() > nowMs;
      if (isFresh) {
        return this.materialize(cached);
      }
      // Stale → fire-and-forget refresh; отдаём устаревшее.
      void this.refreshUnderLock(broadcastId).catch((err) => {
        this.logger.warn(
          `async refresh failed for ${broadcastId}: ${(err as Error).message}`,
        );
      });
      return this.materialize(cached);
    }

    // Записи нет — synchronous refresh под lock.
    return this.refreshUnderLock(broadcastId);
  }

  /**
   * Synchronous refresh с dedup'ом через Redis-lock. Если lock занят —
   * poll'им БД до 5с (POLL_MAX_ATTEMPTS × POLL_INTERVAL_MS). Если запись
   * появилась — отдаём её. Если нет — пытаемся всё-таки сделать refresh
   * (другой инстанс мог упасть до записи).
   */
  private async refreshUnderLock(
    broadcastId: string,
  ): Promise<CrosstableResponse> {
    const lockKey = `${REFRESH_LOCK_KEY_PREFIX}:${broadcastId}`;
    const acquired = await this.redis
      .set(lockKey, String(this.now()), 'EX', REFRESH_LOCK_TTL_SEC, 'NX')
      .catch(() => null);

    if (acquired !== 'OK') {
      // Кто-то уже идёт по refresh. Poll'им БД до появления записи.
      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await this.sleep(POLL_INTERVAL_MS);
        const cached = await this.prisma.broadcastStandings.findUnique({
          where: { broadcastId },
        });
        if (cached) return this.materialize(cached);
      }
      // Не дождались — пробуем своими силами.
      this.logger.warn(
        `lock-wait timeout for ${broadcastId}, retrying refresh ourselves`,
      );
    }

    try {
      return await this.refresh(broadcastId);
    } finally {
      if (acquired === 'OK') {
        await this.redis.del(lockKey).catch(() => {});
      }
    }
  }

  /**
   * Полный refresh: fetch + парсинг + матчинг + persist + metric.
   * Бросает только при «broadcast не найден» — все остальные ошибки
   * (fetch fail, parser mismatch) обёрнуты в legacy-fallback.
   */
  async refresh(broadcastId: string): Promise<CrosstableResponse> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
      include: {
        rounds: {
          include: { games: true },
        },
      },
    });
    if (!broadcast) {
      throw new Error(`broadcast ${broadcastId} not found`);
    }

    const lifecycle = await this.computeLifecycle(broadcastId);
    const tournamentType = detectTournamentType({
      format: broadcast.format ?? null,
      hasTeamTable: broadcast.teamTable,
    } satisfies DetectInput);

    const tid = broadcast.chessResultsTournamentId;

    if (!tid || tournamentType === 'unknown') {
      const reason = !tid
        ? 'broadcast.chessResultsTournamentId is null (Lichess standings_url not chess-results)'
        : `tournamentType='unknown' for format='${broadcast.format}'`;
      const response = this.buildLegacyResponse(broadcast, reason);
      await this.persist(broadcastId, response, lifecycle, tournamentType);
      this.refreshTotal.inc({ status: 'legacy', type: tournamentType });
      return response;
    }

    let response: CrosstableResponse;
    try {
      switch (tournamentType) {
        case 'round-robin':
          response = await this.buildRoundRobin(broadcast, tid, lifecycle);
          break;
        case 'swiss':
          response = await this.buildSwiss(broadcast, tid, lifecycle);
          break;
        case 'team-swiss':
        case 'team-round-robin':
          response = await this.buildTeam(
            broadcast,
            tid,
            lifecycle,
            tournamentType,
          );
          break;
      }
      this.refreshTotal.inc({ status: 'ok', type: tournamentType });
    } catch (err: unknown) {
      const msg = (err as Error).message;
      this.logger.warn(
        `refresh ${broadcastId} fell back to legacy: ${msg}`,
      );
      response = this.buildLegacyResponse(
        broadcast,
        `chess-results error: ${msg}`,
      );
      const errorStatus = this.classifyError(err);
      this.refreshTotal.inc({ status: errorStatus, type: tournamentType });
    }

    await this.persist(broadcastId, response, lifecycle, tournamentType);
    return response;
  }

  // ── Builders по типам турниров ─────────────────────────────────────

  private async buildRoundRobin(
    broadcast: BroadcastWithRounds,
    tid: string,
    lifecycle: Lifecycle,
  ): Promise<CrosstableResponse> {
    const html = await this.fetcher.fetchPage(tid, 5, lifecycle);
    const parsed = parseRrCrosstable(html);
    if (!parsed.ok) {
      throw new Error(`parseRrCrosstable failed: ${parsed.reason}`);
    }
    const refs = this.composeRefs(broadcast, parsed.data.players);
    // Заполнить gameRef в matrix-cells по (rowRank, opponentRank, roundLabel).
    // Для RR roundLabel вычислим по «классическому» round-robin сопоставлению —
    // chess-results art=5 сам не отдаёт roundNumber для конкретной ячейки;
    // sync-service делает best-effort: если в game.round.name есть число,
    // используем его. Иначе — оставляем gameRef=null и UI без клика.
    const matrix: CrosstableCell[][] = parsed.data.matrix.map(
      (row, rowIdx) => {
        const playerRank = parsed.data.players[rowIdx]?.rank ?? rowIdx + 1;
        return row.map((cell) => {
          if (cell.opponentRank == null || cell.result == null) {
            return cell;
          }
          // Перебираем все refs, ищем подходящий (rowRank vs oppRank).
          for (const [, ref] of refs) {
            // key = "<round>:<white>:<black>". Не знаем кто белый — допустим
            // оба варианта.
            // (см. composeGameRefs key format).
          }
          // Простая эвристика: ищем по indexes без знания цвета.
          let gameRef: CrosstableCell['gameRef'] = null;
          for (const [key, ref] of refs) {
            const parts = key.split(':');
            const w = Number.parseInt(parts[1], 10);
            const b = Number.parseInt(parts[2], 10);
            if (
              (w === playerRank && b === cell.opponentRank) ||
              (b === playerRank && w === cell.opponentRank)
            ) {
              gameRef = ref;
              break;
            }
          }
          return { ...cell, gameRef };
        });
      },
    );
    return {
      tournamentType: 'round-robin',
      sourceType: 'chess-results',
      sourceUrl: SOURCE_URL_TPL(tid),
      fetchedAt: new Date(this.now()).toISOString(),
      players: parsed.data.players,
      matrix,
    } satisfies CrosstableRoundRobin;
  }

  private async buildSwiss(
    broadcast: BroadcastWithRounds,
    tid: string,
    lifecycle: Lifecycle,
  ): Promise<CrosstableResponse> {
    // 1. Standings (art=1) — обязательны (даёт rank/points/tiebreaks).
    const rankingHtml = await this.fetcher.fetchPage(tid, 1, lifecycle);
    const ranking = parseSwissRanking(rankingHtml);
    if (!ranking.ok) {
      throw new Error(`parseSwissRanking failed: ${ranking.reason}`);
    }

    // 2. Pairings (art=2) — best-effort. Если упадёт — отдадим standings
    // без матрицы pairings (ну, пустую).
    let pairingsRounds: ReturnType<typeof parseSwissPairings> | null = null;
    try {
      const pairingsHtml = await this.fetcher.fetchPage(tid, 2, lifecycle);
      pairingsRounds = parseSwissPairings(pairingsHtml);
    } catch (err) {
      // Любая ошибка при fetch art=2 — продолжаем без pairings.
      this.logger.warn(
        `swiss pairings fetch failed for ${tid}: ${(err as Error).message}`,
      );
    }

    const refs = this.composeRefs(broadcast, ranking.data.players);
    const N = ranking.data.players.length;
    const R = ranking.data.roundCount;
    const pairings: CrosstableCell[][] = Array.from({ length: N }, () =>
      Array.from({ length: R }, () => ({ result: null }) as CrosstableCell),
    );

    if (pairingsRounds && pairingsRounds.ok) {
      // По каждому туру строим mapping snr → playerRank.
      const snrToRank = new Map<number, number>();
      // chess-results SNR колонки нет в parseSwissRanking — берём по
      // нормализованному имени.
      const nameToRank = new Map<string, number>();
      for (const p of ranking.data.players) {
        nameToRank.set(p.normalizedName, p.rank);
      }
      for (const round of pairingsRounds.data.rounds) {
        const ri = round.roundNumber - 1;
        if (ri < 0 || ri >= R) continue;
        for (const pair of round.pairs) {
          if (!pair.white) continue;
          const wRank =
            nameToRank.get(pair.white.normalizedName) ?? null;
          const bRank = pair.black
            ? (nameToRank.get(pair.black.normalizedName) ?? null)
            : null;
          if (wRank === null) continue;
          // Заполняем cell для белого.
          const wCell: CrosstableCell = {
            opponentRank: bRank ?? undefined,
            color: 'white',
            result: pair.isBye
              ? 'bye'
              : pair.result ?? null,
            gameRef: this.findGameRef(refs, round.roundNumber, wRank, bRank),
          };
          pairings[wRank - 1][ri] = wCell;
          // Зеркало для чёрного.
          if (bRank !== null) {
            const bResult: CrosstableCell['result'] =
              pair.result === 'win'
                ? 'loss'
                : pair.result === 'loss'
                  ? 'win'
                  : pair.result === 'draw'
                    ? 'draw'
                    : pair.result;
            pairings[bRank - 1][ri] = {
              opponentRank: wRank,
              color: 'black',
              result: bResult,
              gameRef: this.findGameRef(refs, round.roundNumber, wRank, bRank),
            };
          }
        }
      }
      void snrToRank;
    }

    return {
      tournamentType: 'swiss',
      sourceType: 'chess-results',
      sourceUrl: SOURCE_URL_TPL(tid),
      fetchedAt: new Date(this.now()).toISOString(),
      players: ranking.data.players,
      roundCount: R,
      pairings,
    } satisfies CrosstableSwiss;
  }

  private async buildTeam(
    broadcast: BroadcastWithRounds,
    tid: string,
    lifecycle: Lifecycle,
    tournamentType: 'team-swiss' | 'team-round-robin',
  ): Promise<CrosstableResponse> {
    // 1. Team standings (art=0) — список команд.
    const standingsHtml = await this.fetcher.fetchPage(tid, 0, lifecycle);
    const standings = parseTeamStandings(standingsHtml);
    if (!standings.ok) {
      throw new Error(`parseTeamStandings failed: ${standings.reason}`);
    }

    // 2. Composition (art=1) — игроки по командам. Best-effort.
    let players: CrosstablePlayer[] = [];
    try {
      const compHtml = await this.fetcher.fetchPage(tid, 1, lifecycle);
      const comp = parseTeamComposition(compHtml);
      if (comp.ok) players = comp.data.players;
    } catch (err) {
      this.logger.warn(
        `team composition fetch failed for ${tid}: ${(err as Error).message}`,
      );
    }

    return {
      tournamentType,
      sourceType: 'chess-results',
      sourceUrl: SOURCE_URL_TPL(tid),
      fetchedAt: new Date(this.now()).toISOString(),
      players,
      teams: standings.data.teams,
    } satisfies CrosstableTeam;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private buildLegacyResponse(
    broadcast: BroadcastWithRounds,
    reason: string,
  ): CrosstableLegacy {
    const players = this.buildLegacyPlayersFromGames(broadcast);
    return {
      tournamentType: 'unknown',
      sourceType: 'internal-fallback',
      sourceUrl: null,
      fetchedAt: null,
      players,
      reason,
    };
  }

  /**
   * Список игроков из `broadcast_games` для legacy-fallback. Уникальность
   * по нормализованному имени, points и gamesPlayed считаются по
   * `result`-полям partii (1-0, 0-1, 1/2-1/2). Это поведение совпадает с
   * текущим `/standings`-endpoint'ом (ADR-021), просто переехало сюда.
   */
  private buildLegacyPlayersFromGames(
    broadcast: BroadcastWithRounds,
  ): CrosstablePlayer[] {
    const acc = new Map<
      string,
      { name: string; points: number; gamesPlayed: number; elo: number | null }
    >();
    const allGames = broadcast.rounds.flatMap((r) => r.games);
    for (const g of allGames) {
      const w = g.whitePlayer?.trim() ?? '';
      const b = g.blackPlayer?.trim() ?? '';
      const result = g.result ?? '';
      const wScore =
        result === '1-0' ? 1 : result === '0-1' ? 0 : result === '1/2-1/2' ? 0.5 : null;
      const bScore = wScore == null ? null : 1 - wScore;
      if (w) {
        const nw = normalizePlayerName(w);
        const cur = acc.get(nw) ?? {
          name: w,
          points: 0,
          gamesPlayed: 0,
          elo: null,
        };
        if (wScore !== null) {
          cur.points += wScore;
          cur.gamesPlayed += 1;
        }
        if (cur.elo == null && g.whiteElo != null) cur.elo = g.whiteElo;
        acc.set(nw, cur);
      }
      if (b) {
        const nb = normalizePlayerName(b);
        const cur = acc.get(nb) ?? {
          name: b,
          points: 0,
          gamesPlayed: 0,
          elo: null,
        };
        if (bScore !== null) {
          cur.points += bScore;
          cur.gamesPlayed += 1;
        }
        if (cur.elo == null && g.blackElo != null) cur.elo = g.blackElo;
        acc.set(nb, cur);
      }
    }
    const players: CrosstablePlayer[] = Array.from(acc.entries())
      .map(([norm, v], idx) => ({
        rank: idx + 1,
        name: v.name,
        normalizedName: norm,
        points: v.points,
        gamesPlayed: v.gamesPlayed,
        elo: v.elo ?? undefined,
      }))
      .sort((a, b) => b.points - a.points);
    // После сортировки переустановим rank = индекс + 1.
    return players.map((p, i) => ({ ...p, rank: i + 1 }));
  }

  /**
   * Строит индекс GameRef для данной combinations rank×rank×round.
   * Использует `composeGameRefs` (KS-1732).
   */
  private composeRefs(
    broadcast: BroadcastWithRounds,
    chessResultsPlayers: ReadonlyArray<CrosstablePlayer>,
  ): Map<string, ReturnType<typeof Object>> {
    const games: BroadcastGameInput[] = broadcast.rounds.flatMap((r) =>
      r.games.map((g) => ({
        id: g.id,
        whitePlayer: g.whitePlayer,
        blackPlayer: g.blackPlayer,
        whiteElo: g.whiteElo,
        blackElo: g.blackElo,
        roundId: g.roundId,
      })),
    );
    const roundsById = new Map<string, BroadcastRoundInput>(
      broadcast.rounds.map((r) => [
        r.id,
        { id: r.id, name: r.name, startsAt: r.startsAt },
      ]),
    );
    const fakeMetrics: MatcherMetrics = {
      recordAmbiguousMatch: () => {},
      recordUnmatchedPlayer: () => {},
    };
    return composeGameRefs(
      games,
      chessResultsPlayers,
      roundsById,
      undefined,
      fakeMetrics,
    ) as unknown as Map<string, ReturnType<typeof Object>>;
  }

  private findGameRef(
    refs: Map<string, ReturnType<typeof Object>>,
    roundNumber: number,
    whiteRank: number,
    blackRank: number | null,
  ): CrosstableCell['gameRef'] {
    if (blackRank === null) return null;
    const key = `${roundNumber}:${whiteRank}:${blackRank}`;
    const v = refs.get(key);
    return (v as CrosstableCell['gameRef']) ?? null;
  }

  /**
   * Lifecycle (live/upcoming/finished) — переиспользуем тот же SQL что в
   * `BroadcastController.computeBroadcastDetails`, но упрощённый: только
   * нужный broadcast и без pinning-метрик.
   */
  async computeLifecycle(broadcastId: string): Promise<Lifecycle> {
    const upcomingWindowHours = parseInt(
      process.env.BROADCAST_PINNED_UPCOMING_HOURS ?? '48',
      10,
    );
    type Row = { has_live: boolean; has_upcoming: boolean };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM broadcast_rounds r
          WHERE r.broadcast_id = ${broadcastId}::uuid
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
          WHERE r.broadcast_id = ${broadcastId}::uuid
            AND r.status = 'pending'
            AND r.starts_at IS NOT NULL
        ) AS has_upcoming
    `;
    const row = rows[0];
    if (!row) return 'finished';
    if (row.has_live) return 'live';
    if (row.has_upcoming) return 'upcoming';
    return 'finished';
  }

  private async persist(
    broadcastId: string,
    response: CrosstableResponse,
    lifecycle: Lifecycle,
    tournamentType: TournamentType,
  ): Promise<void> {
    const ttlMs = TTL_MS_BY_LIFECYCLE[lifecycle];
    const fetchedAt = new Date(this.now());
    const staleAt = new Date(this.now() + ttlMs);
    // Раскладываем response по JSON-колонкам.
    const rawPlayers = response.players;
    const rawCrossTable =
      response.tournamentType === 'round-robin' ? response.matrix : null;
    const rawPairings =
      response.tournamentType === 'swiss' ? response.pairings : null;
    const rawTeams =
      response.tournamentType === 'team-swiss' ||
      response.tournamentType === 'team-round-robin'
        ? response.teams
        : null;
    // Prisma `Json` accepts InputJsonValue; nullable Json — `Prisma.DbNull`
    // или undefined. Кастуем через unknown, чтобы не таскать Prisma-тайпинги.
    const fields = {
      sourceType: response.sourceType,
      sourceUrl: response.sourceUrl,
      tournamentType,
      rawPlayers: rawPlayers as unknown as object,
      rawCrossTable: (rawCrossTable as unknown as object) ?? undefined,
      rawPairings: (rawPairings as unknown as object) ?? undefined,
      rawTeams: (rawTeams as unknown as object) ?? undefined,
      fetchedAt,
      staleAt,
      fetchError:
        response.tournamentType === 'unknown' ? response.reason : null,
    };
    await this.prisma.broadcastStandings.upsert({
      where: { broadcastId },
      update: fields,
      create: { broadcastId, ...fields },
    });
  }

  /**
   * Реконструирует `CrosstableResponse` из persisted-записи. Source-type
   * + типа диктует какой shape у нас в JSON-колонках.
   */
  private materialize(
    cached: PrismaBroadcastStandingsRow,
  ): CrosstableResponse {
    const fetchedAt = cached.fetchedAt.toISOString();
    const players = (cached.rawPlayers as unknown as CrosstablePlayer[]) ?? [];
    const tournamentType = cached.tournamentType as TournamentType;
    if (tournamentType === 'round-robin') {
      return {
        tournamentType: 'round-robin',
        sourceType: cached.sourceType as 'chess-results' | 'internal-fallback',
        sourceUrl: cached.sourceUrl,
        fetchedAt,
        players,
        matrix: (cached.rawCrossTable as unknown as CrosstableCell[][]) ?? [],
      };
    }
    if (tournamentType === 'swiss') {
      return {
        tournamentType: 'swiss',
        sourceType: cached.sourceType as 'chess-results' | 'internal-fallback',
        sourceUrl: cached.sourceUrl,
        fetchedAt,
        players,
        roundCount: Array.isArray(cached.rawPairings)
          ? (cached.rawPairings[0]?.length ?? 0)
          : 0,
        pairings: (cached.rawPairings as unknown as CrosstableCell[][]) ?? [],
      };
    }
    if (
      tournamentType === 'team-swiss' ||
      tournamentType === 'team-round-robin'
    ) {
      return {
        tournamentType,
        sourceType: cached.sourceType as 'chess-results' | 'internal-fallback',
        sourceUrl: cached.sourceUrl,
        fetchedAt,
        players,
        teams: (cached.rawTeams as unknown as CrosstableTeam['teams']) ?? [],
      };
    }
    // Legacy / unknown.
    return {
      tournamentType: 'unknown',
      sourceType: cached.sourceType as 'chess-results' | 'internal-fallback',
      sourceUrl: cached.sourceUrl,
      fetchedAt: cached.sourceType === 'internal-fallback' ? null : fetchedAt,
      players,
      reason: cached.fetchError ?? 'no reason recorded',
    };
  }

  private classifyError(err: unknown): 'rate_limited' | 'circuit_open' | 'http_throttle' | 'error' {
    if (err instanceof RateLimitedLocalError) return 'rate_limited';
    if (err instanceof CircuitOpenError) return 'circuit_open';
    if (err instanceof HttpThrottleError) return 'http_throttle';
    return 'error';
  }
}

/** Тип Broadcast с подгруженными rounds+games (Prisma include). */
type BroadcastWithRounds = {
  id: string;
  format: string | null;
  teamTable: boolean;
  chessResultsTournamentId: string | null;
  rounds: Array<{
    id: string;
    name: string;
    startsAt: Date | null;
    games: Array<{
      id: string;
      roundId: string;
      whitePlayer: string | null;
      blackPlayer: string | null;
      whiteElo: number | null;
      blackElo: number | null;
      result: string | null;
    }>;
  }>;
};

/** Тип строки `BroadcastStandings` от Prisma (минимальный поверхностный). */
type PrismaBroadcastStandingsRow = {
  id: string;
  broadcastId: string;
  sourceType: string;
  sourceUrl: string | null;
  tournamentType: string;
  rawPlayers: unknown;
  rawCrossTable: unknown;
  rawPairings: unknown;
  rawTeams: unknown;
  fetchedAt: Date;
  staleAt: Date;
  fetchError: string | null;
};
