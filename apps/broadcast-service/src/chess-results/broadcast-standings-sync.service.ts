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
  parseRoundNumber,
  type BroadcastGameInput,
  type BroadcastRoundInput,
  type MatcherMetrics,
} from '../crosstable/player-matcher';
import { parseRrCrosstable } from './parsers/parse-rr-crosstable';
import { sortCrosstableByPoints } from '../crosstable/sort-crosstable';
import { parseSwissRanking } from './parsers/parse-swiss-ranking';
import {
  parseSwissPairings,
  type RawSwissRound,
} from './parsers/parse-swiss-pairings';
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
  CrosstableGameRef,
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

// KS-2723: TTL для `finished` был 24h. Это означало что турнир мог
// сутки висеть без последнего тура, если chess-results не успел
// загрузить CSV финального round'а к моменту первого refresh'а.
// Снижаем до 10 минут — нагрузка на chess-results минимальная (старые
// турниры почти никто не смотрит), а нужный кейс «chess-results
// догрузил тур через 30 мин» покрывается.
//
// Дополнительные слои свежести (KS-2723):
//   1. `getFresh` пересчитывает effectiveStaleAt при чтении из
//      `fetchedAt + currentTTL`, а не использует сохранённый в БД
//      `staleAt`. Это применяет смену TTL ко всем существующим
//      записям без миграции.
//   2. `BroadcastSyncService.processPgnUpdate` инвалидирует кэш
//      события — когда приходит новый финальный result или новая
//      partia в новом round'е, мы DELETE'аем broadcast_standings,
//      и следующий /crosstable пересоберётся.
const TTL_MS_BY_LIFECYCLE: Record<Lifecycle, number> = {
  live: 5 * 60 * 1000,
  upcoming: 60 * 60 * 1000,
  finished: 10 * 60 * 1000,
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

/**
 * KS-2564: фильтр раундов круговой таблицы. Тайбрейки и armageddon —
 * отдельная playoff-стадия (детектор `detect-round-tournament-type.ts`
 * проставляет `tournamentType='playoff'` при upsert'е раунда). Их
 * партии должны идти только в /bracket-эндпоинт, не в crosstable.
 *
 * `null` — legacy-раунды до KS-1813, для back-compat считаем
 * безопасными.
 *
 * `unknown` — раунд не классифицирован (нет имени-маркера, нет формата,
 * нет структурного сигнала). По умолчанию пропускаем (не блокируем
 * трансляцию из-за ошибки детектора).
 */
function isCrosstableRound(round: {
  tournamentType: string | null | undefined;
}): boolean {
  return round.tournamentType !== 'playoff';
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
      // KS-2723: effectiveStaleAt пересчитываем из текущего TTL +
      // фактической fetchedAt, а не используем сохранённый в БД
      // `staleAt` (он мог быть рассчитан по старому TTL — например
      // 24h для finished до KS-2723 — и заморозил кэш на сутки).
      // Минимум из двух — берём более «свежую» границу.
      const lifecycle = await this.computeLifecycle(broadcastId);
      const ttlMs = TTL_MS_BY_LIFECYCLE[lifecycle];
      const fetchedMs = cached.fetchedAt.getTime();
      const effectiveStaleMs = Math.min(
        cached.staleAt.getTime(),
        fetchedMs + ttlMs,
      );
      const isFresh = effectiveStaleMs > nowMs;
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
   * KS-2723: event-driven инвалидация кэша. Вызывается из
   * `BroadcastSyncService.processPgnUpdate` когда приходит
   * PGN-обновление с новым финальным result или новой partіей в
   * новом round'е. Пересоберётся при следующем `/crosstable`.
   *
   * Идемпотентно: если записи нет — no-op без ошибки.
   */
  async invalidate(broadcastId: string): Promise<void> {
    try {
      await this.prisma.broadcastStandings.delete({
        where: { broadcastId },
      });
      this.logger.log(
        `[standings] invalidated cache for ${broadcastId}`,
      );
    } catch (e: unknown) {
      // Prisma бросает P2025 если записи нет — это норма.
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'P2025') {
        this.logger.warn(
          `[standings] invalidate ${broadcastId} failed: ${(e as Error).message}`,
        );
      }
    }
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

    // KS-1749: единственный legit-кейс для CrosstableLegacy — `unknown`
    // detect (формат не распознан). Если detect дал реальный тип, но нет
    // chess-results id — строим internal-fallback с тем же типом, чтобы
    // фронт-диспетчер показал правильную таблицу (даже частично
    // заполненную из broadcast_games).
    if (tournamentType === 'unknown') {
      const reason = `tournamentType='unknown' for format='${broadcast.format ?? ''}'`;
      const response = sortCrosstableByPoints(
        this.buildLegacyResponse(broadcast, reason),
      );
      await this.persist(broadcastId, response, lifecycle);
      this.refreshTotal.inc({ status: 'legacy', type: tournamentType });
      return response;
    }

    if (!tid) {
      // Нет chess-results id (Lichess standings_url не туда ведёт), но
      // detected тип известен — заполняем internal-fallback shape.
      const reason =
        'broadcast.chessResultsTournamentId is null (Lichess standings_url not chess-results)';
      const response = sortCrosstableByPoints(
        this.buildInternalFallback(broadcast, tournamentType, reason),
      );
      await this.persist(broadcastId, response, lifecycle, reason);
      this.refreshTotal.inc({ status: 'legacy', type: tournamentType });
      return response;
    }

    let response: CrosstableResponse;
    let fetchErrReason: string | null = null;
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
        `refresh ${broadcastId} fell back to internal-fallback (${tournamentType}): ${msg}`,
      );
      // KS-1749: при ошибке fetch/parse держим detected тип, не
      // схлопываемся в unknown. Discriminator должен соответствовать
      // реальной природе турнира — фронт сам решит как рендерить.
      fetchErrReason = `chess-results error: ${msg}`;
      response = this.buildInternalFallback(
        broadcast,
        tournamentType,
        fetchErrReason,
      );
      const errorStatus = this.classifyError(err);
      this.refreshTotal.inc({ status: errorStatus, type: tournamentType });
    }

    // KS-2477: сортируем `players[]` по убыванию очков (с tiebreak'ом)
    // и пересобираем `matrix` / `pairings` под новый порядок. Это
    // последний шаг для всех веток (chess-results / fetch-error
    // fallback / unknown / no-id), чтобы фронт получал готовую
    // отсортированную таблицу независимо от источника.
    response = sortCrosstableByPoints(response);

    await this.persist(broadcastId, response, lifecycle, fetchErrReason);
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

    const N = ranking.data.players.length;
    const R = ranking.data.roundCount;

    // KS-2723: chess-results может отставать от Lichess broadcast — у
    // Ostrava 2026 (FIDE Open A) на момент завершения турнира chess-
    // results вернул только 8 туров, хотя в БД (и у Lichess) есть Round 9
    // с финальными результатами. Если в нашей БД больше «классических»
    // round'ов с финальными partіями, чем chess-results показывает —
    // отказываемся от chess-results и fallback'имся на internal-fallback
    // (он строит pairings из `broadcast_games` всем известным round'ам).
    const dbRoundsWithFinalGames = broadcast.rounds
      .filter(isCrosstableRound)
      .filter((rd) =>
        rd.games.some((g) => g.result && g.result !== '*'),
      ).length;
    if (dbRoundsWithFinalGames > R) {
      this.logger.warn(
        `swiss chess-results stale for tid=${tid}: ` +
          `chess-results.roundCount=${R}, db.roundsWithFinalGames=${dbRoundsWithFinalGames}. ` +
          `Falling back to internal pairings.`,
      );
      throw new Error(
        `chess-results stale: roundCount=${R} < db=${dbRoundsWithFinalGames}`,
      );
    }

    // 2. Pairings per-round (KS-2206): fetching art=2 without `rd` returns
    //    only the current + next round. To get all played rounds we request
    //    art=2&rd=K for each K=1..R separately (ADR-023 §2.5).
    //    Each (tid, art=2, rd=K) has its own Redis rate-limit key so rounds
    //    are cached independently with the same lifecycle TTL.
    const fetchedRounds = new Map<number, RawSwissRound>();
    for (let rd = 1; rd <= R; rd++) {
      try {
        const html = await this.fetcher.fetchPage(tid, 2, lifecycle, rd);
        const parsed = parseSwissPairings(html);
        if (parsed.ok) {
          // Take the target round only (art=2&rd=K may still include a
          // "next round" row where all players are "not paired").
          const target = parsed.data.rounds.find((r) => r.roundNumber === rd);
          if (target) fetchedRounds.set(rd, target);
        }
      } catch (err) {
        // Rate-limit or network error — continue without this round.
        this.logger.warn(
          `swiss pairings rd=${rd} fetch failed for ${tid}: ${(err as Error).message}`,
        );
      }
    }

    const refs = this.composeRefs(broadcast, ranking.data.players);
    // Fallback: name-based gameRef lookup (KS-2206) — when rank-based
    // composeGameRefs fails to match a player by name, try direct match
    // on normalised names in broadcast_games.
    const gamesByNorm = this.buildGamesByNormMap(broadcast);

    const pairings: CrosstableCell[][] = Array.from({ length: N }, () =>
      Array.from({ length: R }, () => ({ result: null }) as CrosstableCell),
    );

    const nameToRank = new Map<string, number>();
    for (const p of ranking.data.players) {
      nameToRank.set(p.normalizedName, p.rank);
    }

    for (const [, round] of fetchedRounds) {
      const ri = round.roundNumber - 1;
      if (ri < 0 || ri >= R) continue;
      for (const pair of round.pairs) {
        if (!pair.white) continue;
        const wRank = nameToRank.get(pair.white.normalizedName) ?? null;
        const bRank = pair.black
          ? (nameToRank.get(pair.black.normalizedName) ?? null)
          : null;
        if (wRank === null) continue;

        const gameRef = this.findGameRefWithFallback(
          refs,
          gamesByNorm,
          round.roundNumber,
          wRank,
          bRank,
          pair.white.normalizedName,
          pair.black?.normalizedName ?? null,
        );

        const wCell: CrosstableCell = {
          opponentRank: bRank ?? undefined,
          color: 'white',
          result: pair.isBye ? 'bye' : (pair.result ?? null),
          gameRef,
        };
        pairings[wRank - 1][ri] = wCell;

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
            gameRef,
          };
        }
      }
    }

    // Fix gamesPlayed=0 (KS-2206): chess-results art=1 ranking table doesn't
    // have a «Games» column. Compute from pairings: count non-null results.
    const players = ranking.data.players.map((p, idx) => {
      const played = pairings[idx]
        ? pairings[idx].filter(
            (c) =>
              c.result !== null &&
              c.result !== 'bye' &&
              c.result !== 'forfeit',
          ).length
        : 0;
      return { ...p, gamesPlayed: played };
    });

    return {
      tournamentType: 'swiss',
      sourceType: 'chess-results',
      sourceUrl: SOURCE_URL_TPL(tid),
      fetchedAt: new Date(this.now()).toISOString(),
      players,
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
   * KS-1749: internal-fallback с сохранением **detected типа турнира**.
   * Используется когда у broadcast'а нет `chessResultsTournamentId` или
   * fetch/парсер chess-results упал — но мы ВСЁ ЕЩЁ знаем тип из
   * `Broadcast.format`. Discriminator во фронте уходит в правильный
   * рендер (`<TeamStandings>` для team-*, `<RoundRobinCrosstable>` для
   * round-robin, `<BroadcastSwissStandings>` для swiss), даже если
   * данных мало — лучше частичное отображение, чем пустой legacy
   * empty-state.
   *
   * Players берутся из `broadcast_games` (`buildLegacyPlayersFromGames`)
   * с извлечением `team`-поля из PGN-тэгов `[WhiteTeam]/[BlackTeam]`
   * (Lichess broadcast стандарт). Для team-* — `teams[]` группируется
   * из `players[].team` (имя команды + sum points + ranked by points
   * desc); если ни у кого нет team-поля — массив пустой, фронт UX
   * деградирует gracefully.
   *
   * Параметр `reason` пишется в `BroadcastStandings.fetchError` — для
   * аудита почему данные неполные. На фронт `reason` уходит ТОЛЬКО для
   * `CrosstableLegacy` (по shape). Для типизированных вариантов мы
   * `reason` не передаём в response (нет поля), но он сохранится в БД.
   */
  private buildInternalFallback(
    broadcast: BroadcastWithRounds,
    tournamentType: Exclude<TournamentType, 'unknown'>,
    reason: string,
  ): CrosstableResponse {
    const players = this.buildLegacyPlayersFromGames(broadcast);
    void reason; // персистится в `fetchError` отдельно через persist().
    switch (tournamentType) {
      case 'round-robin': {
        // Строим N×N матрицу из broadcast_games (KS-2203). KS-2476:
        // для double / multi-RR (TCEC «octuple round-robin» и т.п.)
        // одна и та же пара играет ≥ 2 партии — все они складываются
        // в `cell.games[]`. Top-level `result/gameRef/color` остаются
        // как backward-compat для старого фронта (последняя партия
        // пары).
        const N = players.length;
        const nameToIdx = new Map<string, number>();
        for (let i = 0; i < players.length; i++) {
          nameToIdx.set(players[i].normalizedName, i);
        }

        // Аккумулятор matrix[i][j]: список встреч с точки зрения
        // игрока i против j. Для каждой реальной партии добавляем
        // одну запись в [i][j] (с цветом и результатом для i) и
        // одну в [j][i] (с противоположным цветом и инвертированным
        // результатом для j).
        type Entry = {
          result: CrosstableCell['result'];
          color: 'white' | 'black';
          gameRef: CrosstableGameRef;
          startsAt: number;
          gameId: string;
          isReal: boolean;
        };
        const accMatrix: Entry[][][] = Array.from({ length: N }, () =>
          Array.from({ length: N }, (): Entry[] => []),
        );

        const roundById = new Map(broadcast.rounds.map((r) => [r.id, r]));
        // KS-2564: тайбрейки/armageddon — отдельная playoff-стадия,
        // их партии не должны попадать в круговую таблицу.
        const crosstableRounds = broadcast.rounds.filter(isCrosstableRound);
        for (const g of crosstableRounds.flatMap((r) => r.games)) {
          const wNorm = normalizePlayerName(g.whitePlayer?.trim() ?? '');
          const bNorm = normalizePlayerName(g.blackPlayer?.trim() ?? '');
          const wi = wNorm ? (nameToIdx.get(wNorm) ?? null) : null;
          const bi = bNorm ? (nameToIdx.get(bNorm) ?? null) : null;
          if (wi === null || bi === null || wi === bi) continue;
          const res = g.result ?? '';
          const wRes: CrosstableCell['result'] =
            res === '1-0'
              ? 'win'
              : res === '0-1'
                ? 'loss'
                : res === '1/2-1/2'
                  ? 'draw'
                  : null;
          const bRes: CrosstableCell['result'] =
            res === '1-0'
              ? 'loss'
              : res === '0-1'
                ? 'win'
                : res === '1/2-1/2'
                  ? 'draw'
                  : null;
          const round = roundById.get(g.roundId);
          const gameRef: CrosstableGameRef = {
            gameId: g.id,
            roundId: g.roundId,
            roundName: round?.name ?? '',
          };
          const startsAt = round?.startsAt?.getTime() ?? 0;
          const isReal = wRes !== null;
          accMatrix[wi][bi].push({
            result: wRes,
            color: 'white',
            gameRef,
            startsAt,
            gameId: g.id,
            isReal,
          });
          accMatrix[bi][wi].push({
            result: bRes,
            color: 'black',
            gameRef,
            startsAt,
            gameId: g.id,
            isReal,
          });
        }

        const matrix: CrosstableCell[][] = accMatrix.map((row, i) =>
          row.map((entries, j): CrosstableCell => {
            if (i === j || entries.length === 0) return { result: null };

            // KS-2214 placeholder-фикс: если для одного и того же
            // roundId есть и реальная (result≠null) запись, и
            // placeholder (result=null) — оставляем только реальную.
            // Для разных roundId — обе как разные туры.
            const byRound = new Map<string, Entry[]>();
            for (const e of entries) {
              const arr = byRound.get(e.gameRef.roundId) ?? [];
              arr.push(e);
              byRound.set(e.gameRef.roundId, arr);
            }
            const cleaned: Entry[] = [];
            const seenGameId = new Set<string>();
            for (const arr of byRound.values()) {
              const real = arr.filter((e) => e.isReal);
              const pick = real.length > 0 ? real : arr;
              for (const e of pick) {
                if (seenGameId.has(e.gameId)) continue;
                seenGameId.add(e.gameId);
                cleaned.push(e);
              }
            }
            // Сортировка: реальные туры впереди по времени; tie-break
            // по gameId для детерминизма.
            cleaned.sort((a, b) => {
              if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
              return a.gameId.localeCompare(b.gameId);
            });

            const last = cleaned[cleaned.length - 1];
            // KS-2476: `games` выставляем только для double / multi-RR
            // (≥ 2 встречи пары). Для single-RR оставляем undefined —
            // backward-compat для старого фронта (KS-2203).
            const games =
              cleaned.length >= 2
                ? cleaned.map((e) => ({
                    result: e.result,
                    color: e.color,
                    gameRef: e.isReal ? e.gameRef : null,
                  }))
                : undefined;
            return {
              opponentRank: players[j].rank,
              result: last.result,
              color: last.color,
              gameRef: last.isReal ? last.gameRef : null,
              ...(games ? { games } : {}),
            };
          }),
        );

        return {
          tournamentType: 'round-robin',
          sourceType: 'internal-fallback',
          sourceUrl: null,
          fetchedAt: null,
          players,
          matrix,
        };
      }
      case 'swiss': {
        // KS-2474: Swiss internal-fallback с pairings из broadcast_games.
        // Раньше возвращался пустой `pairings: []` — фронт рендерил
        // только базовую таблицу без колонок R1..RN с результатами туров.
        // Для трансляций без chess-results-id (Sardinia / vesus.org и
        // т.п.) данные о партиях есть в `broadcast_games` от Lichess
        // BCS API — собираем pairings[playerIdx][roundIdx] напрямую,
        // по аналогии с round-robin internal-fallback (KS-2203).
        const N = players.length;
        // KS-2564: тайбрейки идут в bracket-сетку, не в swiss-pairings.
        const sortedRounds = broadcast.rounds
          .filter(isCrosstableRound)
          .sort((a, b) => {
            // По startsAt ASC, fallback на parseRoundNumber из имени.
            const aTs = a.startsAt?.getTime() ?? null;
            const bTs = b.startsAt?.getTime() ?? null;
            if (aTs !== null && bTs !== null && aTs !== bTs) return aTs - bTs;
            const aN = parseRoundNumber(a.name) ?? Number.POSITIVE_INFINITY;
            const bN = parseRoundNumber(b.name) ?? Number.POSITIVE_INFINITY;
            return aN - bN;
          });
        const R = sortedRounds.length;
        const nameToIdx = new Map<string, number>();
        for (let i = 0; i < players.length; i++) {
          nameToIdx.set(players[i].normalizedName, i);
        }
        const roundIdxById = new Map<string, number>();
        sortedRounds.forEach((r, i) => roundIdxById.set(r.id, i));

        const pairings: CrosstableCell[][] = Array.from({ length: N }, () =>
          Array.from(
            { length: R },
            (): CrosstableCell => ({ result: null }),
          ),
        );

        for (const round of sortedRounds) {
          for (const g of round.games) {
            const wNorm = normalizePlayerName(g.whitePlayer?.trim() ?? '');
            const bNorm = normalizePlayerName(g.blackPlayer?.trim() ?? '');
            const wi = wNorm ? (nameToIdx.get(wNorm) ?? null) : null;
            const bi = bNorm ? (nameToIdx.get(bNorm) ?? null) : null;
            const ri = roundIdxById.get(g.roundId) ?? null;
            if (wi === null || bi === null || ri === null || wi === bi) {
              continue;
            }
            const res = g.result ?? '';
            const wRes: CrosstableCell['result'] =
              res === '1-0'
                ? 'win'
                : res === '0-1'
                  ? 'loss'
                  : res === '1/2-1/2'
                    ? 'draw'
                    : null;
            const bRes: CrosstableCell['result'] =
              res === '1-0'
                ? 'loss'
                : res === '0-1'
                  ? 'win'
                  : res === '1/2-1/2'
                    ? 'draw'
                    : null;
            const gameRef: CrosstableGameRef = {
              gameId: g.id,
              roundId: g.roundId,
              roundName: round.name,
            };
            // KS-2214: не затираем реальный результат placeholder-ом
            // (Lichess создаёт за день placeholder-партии с result='*').
            if (wRes !== null || pairings[wi][ri].result === null) {
              pairings[wi][ri] = {
                opponentRank: players[bi].rank,
                color: 'white',
                result: wRes,
                gameRef: wRes !== null ? gameRef : null,
              };
            }
            if (bRes !== null || pairings[bi][ri].result === null) {
              pairings[bi][ri] = {
                opponentRank: players[wi].rank,
                color: 'black',
                result: bRes,
                gameRef: bRes !== null ? gameRef : null,
              };
            }
          }
        }

        // KS-2206: gamesPlayed = реальные сыгранные партии по pairings.
        // buildLegacyPlayersFromGames уже считает по результатам,
        // но для согласованности с UI (счётчик GP в шапке таблицы)
        // пересчитаем по pairings — каждая ячейка с результатом ≠ bye.
        const playersWithGP = players.map((p, idx) => {
          const played = pairings[idx]
            ? pairings[idx].filter(
                (c) =>
                  c.result !== null &&
                  c.result !== 'bye' &&
                  c.result !== 'forfeit',
              ).length
            : 0;
          return { ...p, gamesPlayed: played };
        });

        return {
          tournamentType: 'swiss',
          sourceType: 'internal-fallback',
          sourceUrl: null,
          fetchedAt: null,
          players: playersWithGP,
          roundCount: R,
          pairings,
        };
      }
      case 'team-swiss':
      case 'team-round-robin':
        return {
          tournamentType,
          sourceType: 'internal-fallback',
          sourceUrl: null,
          fetchedAt: null,
          players,
          teams: this.buildTeamsFromPlayers(players),
        };
    }
  }

  /**
   * Группирует players по `team`-полю и строит сортированную таблицу
   * команд: rank по убыванию суммы points игроков команды. KS-1749 —
   * нужен для internal-fallback team-* турниров без chess-results.
   * Игроки без `team`-поля игнорируются (нечего группировать).
   */
  private buildTeamsFromPlayers(
    players: ReadonlyArray<CrosstablePlayer>,
  ): Array<{ name: string; rank: number; points: number }> {
    const acc = new Map<string, { name: string; points: number }>();
    for (const p of players) {
      const team = p.team?.trim();
      if (!team) continue;
      const cur = acc.get(team) ?? { name: team, points: 0 };
      cur.points += p.points ?? 0;
      acc.set(team, cur);
    }
    return Array.from(acc.values())
      .sort((a, b) => b.points - a.points)
      .map((t, i) => ({ name: t.name, rank: i + 1, points: t.points }));
  }

  /**
   * Список игроков из `broadcast_games` для internal-fallback. Уникальность
   * по нормализованному имени, points и gamesPlayed считаются по
   * `result`-полям partii (1-0, 0-1, 1/2-1/2).
   *
   * KS-1749: дополнительно извлекаются `[WhiteTeam "..."]` /
   * `[BlackTeam "..."]` PGN-тэги (Lichess broadcast стандарт для team-
   * турниров) и заполняется `CrosstablePlayer.team`. Если у игрока в
   * разных партиях разные team-значения (что странно, но возможно —
   * клуб игрока сменился), берём first-seen.
   */
  private buildLegacyPlayersFromGames(
    broadcast: BroadcastWithRounds,
  ): CrosstablePlayer[] {
    type Acc = {
      name: string;
      points: number;
      gamesPlayed: number;
      elo: number | null;
      team: string | null;
    };
    const acc = new Map<string, Acc>();
    // KS-2564: rank/points/gamesPlayed считаем только по классике,
    // тайбрейки идут отдельной стадией (filter согласован с matrix).
    const allGames = broadcast.rounds
      .filter(isCrosstableRound)
      .flatMap((r) => r.games);
    for (const g of allGames) {
      const w = g.whitePlayer?.trim() ?? '';
      const b = g.blackPlayer?.trim() ?? '';
      const result = g.result ?? '';
      const wScore =
        result === '1-0' ? 1 : result === '0-1' ? 0 : result === '1/2-1/2' ? 0.5 : null;
      const bScore = wScore == null ? null : 1 - wScore;
      const { whiteTeam, blackTeam } = extractTeamTags(g.pgn ?? null);
      if (w) {
        const nw = normalizePlayerName(w);
        const cur: Acc = acc.get(nw) ?? {
          name: w,
          points: 0,
          gamesPlayed: 0,
          elo: null,
          team: null,
        };
        if (wScore !== null) {
          cur.points += wScore;
          cur.gamesPlayed += 1;
        }
        if (cur.elo == null && g.whiteElo != null) cur.elo = g.whiteElo;
        if (!cur.team && whiteTeam) cur.team = whiteTeam;
        acc.set(nw, cur);
      }
      if (b) {
        const nb = normalizePlayerName(b);
        const cur: Acc = acc.get(nb) ?? {
          name: b,
          points: 0,
          gamesPlayed: 0,
          elo: null,
          team: null,
        };
        if (bScore !== null) {
          cur.points += bScore;
          cur.gamesPlayed += 1;
        }
        if (cur.elo == null && g.blackElo != null) cur.elo = g.blackElo;
        if (!cur.team && blackTeam) cur.team = blackTeam;
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
        team: v.team ?? undefined,
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
    // KS-2564: для chess-results-таблицы gameRef-маппинг должен ссылаться
    // только на классические партии. Иначе ячейка покажет тайбрейк-игру.
    const crosstableRounds = broadcast.rounds.filter(isCrosstableRound);
    const games: BroadcastGameInput[] = crosstableRounds.flatMap((r) =>
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
      crosstableRounds.map((r) => [
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
   * Fallback gameRef lookup по номеру тура + нормализованным именам (KS-2206).
   * Используется когда rank-based composeGameRefs не находит партию (имена
   * в chess-results и broadcast_games слегка расходятся).
   */
  private findGameRefWithFallback(
    refs: Map<string, ReturnType<typeof Object>>,
    gamesByNorm: Map<string, CrosstableGameRef>,
    roundNumber: number,
    whiteRank: number,
    blackRank: number | null,
    whiteNorm: string,
    blackNorm: string | null,
  ): CrosstableCell['gameRef'] {
    // Primary: rank-based lookup.
    const primary = this.findGameRef(refs, roundNumber, whiteRank, blackRank);
    if (primary !== null) return primary;
    // Fallback: name-based lookup.
    if (whiteNorm && blackNorm) {
      return (
        gamesByNorm.get(`${roundNumber}:${whiteNorm}|${blackNorm}`) ?? null
      );
    }
    return null;
  }

  /**
   * Строит Map keyed by `"roundNumber:normWhite|normBlack"` (и обратный порядок)
   * для name-based gameRef fallback (KS-2206). Партия найдена по roundId →
   * номеру тура + нормализованным именам белого и чёрного.
   */
  private buildGamesByNormMap(
    broadcast: BroadcastWithRounds,
  ): Map<string, CrosstableGameRef> {
    const map = new Map<string, CrosstableGameRef>();
    const roundById = new Map(broadcast.rounds.map((r) => [r.id, r]));
    for (const g of broadcast.rounds.flatMap((r) => r.games)) {
      const round = roundById.get(g.roundId);
      if (!round) continue;
      const rn = parseRoundNumber(round.name);
      if (rn === null) continue;
      const wNorm = normalizePlayerName(g.whitePlayer);
      const bNorm = normalizePlayerName(g.blackPlayer);
      if (!wNorm || !bNorm) continue;
      const ref: CrosstableGameRef = {
        gameId: g.id,
        roundId: round.id,
        roundName: round.name,
      };
      // Both orderings so lookup works regardless of white/black assignment.
      map.set(`${rn}:${wNorm}|${bNorm}`, ref);
      map.set(`${rn}:${bNorm}|${wNorm}`, ref);
    }
    return map;
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

  /**
   * Persist'ит response в `broadcast_standings`. **`tournamentType`
   * берётся ИЗ `response`, не из исходного detect'а** (KS-1745) —
   * discriminator должен совпадать с реальным shape JSON-payload'а.
   *
   * KS-1749: `fallbackReason` пишется в `BroadcastStandings.fetchError`
   * для **любого** `sourceType='internal-fallback'`-ответа (раньше
   * только для CrosstableLegacy с unknown). Это сохраняет аудит-trail
   * «почему данные неполные», даже когда discriminator-тип распознан.
   */
  private async persist(
    broadcastId: string,
    response: CrosstableResponse,
    lifecycle: Lifecycle,
    fallbackReason?: string | null,
  ): Promise<void> {
    // KS-2479: internal-fallback с detected-типом (round-robin / swiss /
    // team-*) строит данные из `broadcast_games` от Lichess BCS — это
    // живой источник, новые партии и переклассификации должны прилетать
    // в API без ручного SQL-сброса. Для таких записей TTL принудительно
    // = live (5 мин), независимо от lifecycle. Раньше lifecycle для
    // трансляций без активных раундов в окне (TCEC, Sardinia после
    // финиша) определялся как `finished` → TTL=24h, и любой backend-фикс
    // (KS-2474, KS-2476, KS-2477) застревал на проде до DELETE-запроса
    // от devops.
    //
    // Для `tournamentType='unknown'` (CrosstableLegacy — полная заглушка
    // без detected-типа) поведение не меняется: TTL по lifecycle.
    // Для chess-results / external источников TTL тоже по lifecycle.
    const baseTtl = TTL_MS_BY_LIFECYCLE[lifecycle];
    const isLiveLikeFallback =
      response.sourceType === 'internal-fallback' &&
      response.tournamentType !== 'unknown';
    const ttlMs = isLiveLikeFallback ? TTL_MS_BY_LIFECYCLE.live : baseTtl;
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
      tournamentType: response.tournamentType,
      rawPlayers: rawPlayers as unknown as object,
      rawCrossTable: (rawCrossTable as unknown as object) ?? undefined,
      rawPairings: (rawPairings as unknown as object) ?? undefined,
      rawTeams: (rawTeams as unknown as object) ?? undefined,
      fetchedAt,
      staleAt,
      // fetchError для аудита: для CrosstableLegacy используем
      // встроенный response.reason, для типизированных internal-fallback
      // — переданный fallbackReason.
      fetchError:
        response.tournamentType === 'unknown'
          ? response.reason
          : (response.sourceType === 'internal-fallback'
              ? (fallbackReason ?? null)
              : null),
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
    return sortCrosstableByPoints(this.materializeRaw(cached));
  }

  /**
   * KS-2477: «сырая» десериализация cached row в response shape.
   * Применение sortCrosstableByPoints отделено в `materialize()` —
   * чтобы старые записи в кэше (созданные до KS-2477) тоже выдавались
   * отсортированными без принудительного refresh.
   */
  private materializeRaw(
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
    /** KS-2564: тип стадии раунда (`detect-round-tournament-type.ts`).
     *  `playoff` исключаются из crosstable. `null` — legacy (back-compat). */
    tournamentType: string | null;
    games: Array<{
      id: string;
      roundId: string;
      whitePlayer: string | null;
      blackPlayer: string | null;
      whiteElo: number | null;
      blackElo: number | null;
      result: string | null;
      /** PGN-текст; используется для извлечения [WhiteTeam]/[BlackTeam]
       *  тэгов в internal-fallback (KS-1749). null если игра ещё без PGN. */
      pgn: string | null;
    }>;
  }>;
};

/**
 * Извлекает `[WhiteTeam "..."]` и `[BlackTeam "..."]` PGN-тэги из текста
 * партии. Lichess в broadcast PGN кладёт эти тэги для team-турниров
 * (Bundesliga, ECC, FIDE Olympiad и т.п.). Пустая строка PGN или
 * отсутствие тэгов → `null`.
 */
function extractTeamTags(pgn: string | null): {
  whiteTeam: string | null;
  blackTeam: string | null;
} {
  if (!pgn) return { whiteTeam: null, blackTeam: null };
  const wMatch = /\[WhiteTeam\s+"([^"]*)"\]/i.exec(pgn);
  const bMatch = /\[BlackTeam\s+"([^"]*)"\]/i.exec(pgn);
  return {
    whiteTeam: wMatch && wMatch[1].trim() ? wMatch[1].trim() : null,
    blackTeam: bMatch && bMatch[1].trim() ? bMatch[1].trim() : null,
  };
}

/** Тип Broadcast с подгруженными rounds+games (Prisma include).
 *  Дополнен `pgn` в games — для извлечения [WhiteTeam]/[BlackTeam] тэгов
 *  в KS-1749 internal-fallback. */
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
