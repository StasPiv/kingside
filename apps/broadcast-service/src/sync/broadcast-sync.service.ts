import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Chess } from 'chess.js';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SyncMetricsService } from './sync-metrics';
import { BroadcastStandingsSyncService } from '../chess-results/broadcast-standings-sync.service';
import {
  BROADCAST_MOVE_CHANNEL,
  BROADCAST_SYNC_CHANNEL,
} from './broadcast-channels';
import { runStaleCheck } from './stale-check';
import { extractChessResultsTournamentId } from './extract-chess-results-id';
import { extractTournamentFormatFromTitle } from '../crosstable/extract-tournament-format';
import { detectRoundTournamentType } from '../crosstable/detect-round-tournament-type';
import { classifyRoundBrackets } from '../crosstable/classify-round-brackets';
import { applyBracketLinks } from '../crosstable/apply-bracket-links';

/**
 * Sync-сервис Lichess broadcasts (ADR-022 §2.6 шаг 0).
 *
 * Перенесён из `apps/broadcast-worker/src/worker.ts` как `@Injectable()`
 * с `OnModuleInit`/`OnModuleDestroy`. Логика sync/pinned-poll/stale-check/
 * pgn-fetch/FEN и все константы — 1-в-1 (ADR §2.7).
 *
 * Флаг `BROADCAST_SYNC_ENABLED` (default `false`): если `!= 'true'` — таймеры
 * не запускаются, остальной HTTP работает как раньше (ADR §2.6 шаг 0 §3).
 *
 * Redis-ключи (без изменений):
 *  - `broadcast:sync:lock` (TTL 4 мин)
 *  - `broadcast:pinned:lock` (TTL 50 с)
 *  - `broadcast:pgn-hash:<roundId>` (TTL 5 мин)
 *  - `broadcast:pgn-fetch-cooldown:<roundId>` (TTL 1 ч)
 *  - `broadcast:fen:<roundId>:<idx>` (TTL 12 ч)
 *  - `broadcast:miss-count:<lichessId>` (TTL = staleCycles × syncInterval × 2)
 *
 * Единственное изменение по смыслу относительно worker.ts —
 * **убран fallback на `DATABASE_URL`** (тех.долг, ADR §2.4.3). Prisma-клиент
 * даёт `PrismaService`, который использует только `BROADCASTS_DATABASE_URL`.
 */

const LICHESS_API = 'https://lichess.org/api';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
// KS-1700 Part A: после N пропусков в Lichess top-20 подряд broadcast
// помечается isActive=false. Default 72 цикла × 5 мин = 6 часов.
const DEFAULT_STALE_CYCLES = 72;
const MISS_COUNT_KEY_PREFIX = 'broadcast:miss-count:';
const PINNED_POLL_INTERVAL_MS = 60_000;
// KS-2356: лимиты переведены на ENV для оперативной подстройки без
// redeploy. Default'ы сохранены прежние (5 polls/cycle, 50 streams) —
// при 100 nb broadcast'ов очередь не-streamed ongoing-раундов может
// растягиваться на 30-40 минут. Поднять `BROADCAST_MAX_PGN_POLLS=20`
// и `BROADCAST_MAX_STREAMS=100` для ускорения наполнения партий
// Mitropa/Ostrava и подобных при росте банка.
const MAX_PGN_POLLS_PER_CYCLE = parseInt(
  process.env.BROADCAST_MAX_PGN_POLLS ?? '5',
  10,
);
const REDIS_FEN_TTL = 60 * 60 * 12;
const MAX_CONCURRENT_STREAMS = parseInt(
  process.env.BROADCAST_MAX_STREAMS ?? '50',
  10,
);
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_COOLDOWN_TTL = 60 * 60;
const SYNC_LOCK_KEY = 'broadcast:sync:lock';
const SYNC_LOCK_TTL = 4 * 60;
const PINNED_LOCK_KEY = 'broadcast:pinned:lock';
const PINNED_LOCK_TTL = 50;
const PGN_HASH_TTL = 300;
const RATE_LIMIT_DELAY_MS = 1500;
const RATE_LIMIT_429_BACKOFF_TTL = 60;
const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface LichessBroadcast {
  tour: {
    id: string;
    name: string;
    description?: string;
    url?: string;
    image?: string;
    dates?: [number, number];
    info?: {
      format?: string;
      tc?: string;
      location?: string;
      players?: string;
      website?: string;
      standings?: string;
    };
    /**
     * KS-1735 / ADR-023 §2.3. Lichess отдаёт булевы флаги команды на
     * корне `tour`. Нужны `detectTournamentType` для надёжной классификации
     * командных турниров (без них fallback через regex /team/i по `format`,
     * пропускает кейсы вроде "Match Bundesliga 2024").
     */
    teamTable?: boolean;
    showTeamScores?: boolean;
  };
  rounds: LichessRound[];
}

interface LichessRound {
  id: string;
  name: string;
  startsAt?: number;
  ongoing?: boolean;
  finished?: boolean;
}

interface ParsedGame {
  index: number;
  white: string;
  black: string;
  whiteElo: number | null;
  blackElo: number | null;
  result: string;
  fen: string;
  uci: string;
  pgn: string;
  lichessGameId: string | null;
  /**
   * KS-2699: оставшееся время белых на момент последнего хода, мс.
   * Извлечено из `%clk H:MM:SS` PGN-комментариев (Lichess broadcast стандарт).
   * `null` если в текущем PGN нет ни одного `%clk` для белых
   * (партия до старта / источник без clocks).
   */
  whiteClockMs: number | null;
  /** KS-2699: то же для чёрных. */
  blackClockMs: number | null;
}

/**
 * KS-2699 / KS-2720: извлечь оставшееся время игроков из PGN-комментариев.
 *
 * Lichess broadcast PGN после каждого хода вставляет
 * `{ [%eval ...] [%clk H:MM:SS] }` (формат стандартный, lichess
 * порядок eval→clk). До KS-2720 определяли цвет хода по чётности
 * индекса %clk (0=белые, 1=чёрные, …) — это ломается:
 *  - на стартовых FEN side=b (Chess960 / задачи / эндшпиль-турниры);
 *  - на инкрементальных stream-блоках, где видна только часть ходов;
 *  - если у одной стороны %clk пропущен (Lichess иногда не отдаёт).
 *
 * Сейчас идём по PGN body последовательно, для каждого хода читаем
 * перед ним номер `n.` (белые) или `n...` (чёрные) — этот маркер
 * Lichess пишет ВСЕГДА, даже когда отдаёт не все ходы. Цвет определяем
 * по числу точек: ровно 1 → белые, ≥3 → чёрные. После хода смотрим
 * опциональный `{ ... %clk H:MM:SS ... }`. Берём ПОСЛЕДНИЙ %clk каждой
 * стороны (= актуальный остаток на момент последнего хода игрока).
 *
 * Возвращает `{ null, null }` если ни одного %clk нет — клиент увидит
 * `clockUpdatedAt=null` и не будет рисовать таймеры.
 */
export function extractClocksFromPgn(pgnSection: string): {
  whiteMs: number | null;
  blackMs: number | null;
} {
  // State-machine: идём по токенам PGN body, отслеживаем текущий
  // цвет на ходу. `n.` / `n...` явно фиксирует цвет, обычный
  // SAN-ход — toggle от предыдущего. Между ходом и комментарием
  // `{ ... }` берём %clk и привязываем к стороне, СДЕЛАВШЕЙ ход.
  //
  // Поддерживаемые формы:
  //   `1. e4 e5`             — стандартный сокращённый PGN;
  //   `1. e4 1... e5`        — Lichess broadcast (полная форма);
  //   `1... e5`              — инкремент / стартовый FEN side=b;
  //   `1. e4 {...} 1... e5 {...}` — Lichess с %eval/%clk-комментариями.
  //
  // Стартовая сторона: white по умолчанию (стандартный шахматы).
  // Если первый встретившийся номер — `n...`, переключаемся на black
  // (стартовая сторона b).

  // Удаляем headers — всё до первой пустой строки. PGN body может
  // содержать `[`-токены (например, в эскейпированных комментариях),
  // но в стандартном Lichess PGN — нет.
  const bodyStart = pgnSection.indexOf('\n\n');
  const body =
    bodyStart >= 0 ? pgnSection.slice(bodyStart + 2) : pgnSection;

  const tokenRe =
    /(\d+\.+)|(\{[^}]*\})|(\*|1-0|0-1|1\/2-1\/2)|(\$\d+)|(\S+)/g;
  const clkRe = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/;

  let side: 'w' | 'b' = 'w';
  let whiteMs: number | null = null;
  let blackMs: number | null = null;
  let lastSideJustMoved: 'w' | 'b' | null = null;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    const numToken = m[1];
    const commentToken = m[2];
    const resultToken = m[3];
    const nagToken = m[4];
    const moveToken = m[5];

    if (resultToken) break;

    if (numToken) {
      // `1.` → white; `1...` (или больше точек) → black.
      const dots = numToken.replace(/\d/g, '').length;
      side = dots >= 3 ? 'b' : 'w';
      continue;
    }

    if (commentToken) {
      // Привязываем %clk к стороне, СДЕЛАВШЕЙ предыдущий ход.
      if (lastSideJustMoved == null) continue;
      const c = clkRe.exec(commentToken);
      if (!c) continue;
      const h = parseInt(c[1], 10);
      const min = parseInt(c[2], 10);
      const s = parseFloat(c[3]);
      if (Number.isNaN(h) || Number.isNaN(min) || Number.isNaN(s)) continue;
      const ms = Math.round((h * 3600 + min * 60 + s) * 1000);
      if (lastSideJustMoved === 'w') whiteMs = ms;
      else blackMs = ms;
      continue;
    }

    if (nagToken) {
      // NAG ($1, $2, ...) — пропускаем.
      continue;
    }

    if (moveToken) {
      // SAN-ход: фиксируем сторону, после хода toggle.
      lastSideJustMoved = side;
      side = side === 'w' ? 'b' : 'w';
    }
  }

  return { whiteMs, blackMs };
}

/**
 * KS-2591. Должен ли раунд быть закрыт по итогам PGN-обновления?
 *
 * Контекст: главный sync-цикл (`upsertRound`) переводит раунд в `finished`
 * только когда Lichess отдаёт `round.finished:true`. Но если broadcast
 * выпал из Lichess top-20 и был помечен `is_active=false` ДО того, как
 * Lichess успел обновить флаг — `upsertRound` для его раундов больше не
 * вызывается, а PGN-poll продолжает писать партии. Раунд залипает в
 * `ongoing`, турнир висит в «текущих» (см. историю TePe Sigeman 2026,
 * раунд `o7KV2kHF`).
 *
 * Этот хелпер — второй ремень безопасности рядом с watchdog'ом
 * (KS-2158): когда мы видим, что в текущем PGN все партии с финальным
 * результатом, а раунд ещё `ongoing` — закрываем его, не дожидаясь
 * watchdog tick'а.
 *
 * Условия закрытия (все одновременно):
 *  - есть хотя бы одна распарсенная игра (`games.length > 0`) — пустой PGN
 *    бывает между турами и НЕ должен трактоваться как «всё закрыто»;
 *  - каждая игра имеет финальный `result` (`'1-0' | '0-1' | '1/2-1/2'`),
 *    т.е. ни одна с `'*'` или пустой строкой;
 *  - `currentStatus === 'ongoing'` — `pending`/`finished`/`failed` не трогаем
 *    (pending: ещё не стартовал; finished: уже закрыт; failed: оставляем
 *    оператору решать).
 *
 * Чистая функция, экспортируется для прямого юнит-тестирования.
 */
export function shouldCloseRoundAsFinished(
  games: ReadonlyArray<{ result: string }>,
  currentStatus: string,
): boolean {
  if (currentStatus !== 'ongoing') return false;
  if (games.length === 0) return false;
  for (const g of games) {
    const r = g.result;
    if (!r || r === '*') return false;
  }
  return true;
}

/**
 * KS-2798. Определяет, появился ли в текущей итерации `processPgnUpdate`
 * НОВЫЙ полуход (нужно ли обновить `lastMoveAt`). Логика — независимо
 * от наличия `%clk` в PGN: смотрим на изменение FEN.
 *
 * Возвращает `true` когда:
 *  - партия новая в БД и в pgn уже есть хотя бы один полуход
 *    (FEN ≠ стартовая) → выставим текущий timestamp;
 *  - партия уже существует и `currentFen` изменился на новую позицию.
 *
 * Возвращает `false` когда:
 *  - партия новая, но PGN до старта (FEN = стартовая);
 *  - повторная отдача того же PGN-snapshot'а (FEN не изменился);
 *  - `wouldRegress` (короткий FEN-сброс от Lichess: новый pgn короче и
 *    с stating FEN, но БД хранит позднее состояние — берём существующий
 *    FEN, реального движения нет).
 *
 * Чистая функция, не зависит от prisma/redis. Используется в
 * `processPgnUpdate` и покрыта unit-тестами.
 */
export function detectLastMoveAt(params: {
  existingFen: string | null | undefined;
  newFen: string;
  startingFen: string;
}): boolean {
  const { existingFen, newFen, startingFen } = params;
  // Новая партия (нет существующей записи): фиксируем только когда
  // ходы уже сделаны (FEN ≠ стартовая).
  if (existingFen === null || existingFen === undefined) {
    return newFen !== startingFen;
  }
  // Существующая запись: фиксируем при любом изменении FEN. Регресс к
  // стартовой позиции (короткий PGN от Lichess) обрабатывается уровнем
  // выше — туда передаётся `newFen = existingFen` после wouldRegress.
  return existingFen !== newFen;
}

/**
 * KS-2780. Извлекает значение PGN-header `[Variant "..."]` из строки
 * PGN. Стандарт PGN: variant отсутствует или `Standard` — обычные
 * шахматы; `Chess960` / `Fischer Random` / `Crazyhouse` / etc. —
 * варианты, которые наш просмотрщик не поддерживает.
 *
 * Возвращает значение в нижнем регистре или `null` если header нет.
 * Это источник правды от Lichess (партии в их PGN-стриме приходят
 * с этим header'ом).
 */
export function extractVariantFromPgn(pgn: string): string | null {
  // PGN-header формата `[Variant "..."]`. Берём первое вхождение в
  // первой партии — variant у всех partition'ов одного раунда
  // одинаковый.
  const m = pgn.match(/^\s*\[Variant\s+"([^"]+)"\s*\]/m);
  if (!m) return null;
  return m[1].toLowerCase();
}

/**
 * KS-2780. Проверяет, поддерживаем ли мы данный variant. `null` /
 * `'standard'` / `'chess'` / `'classical'` — стандартные шахматы.
 * Остальное (chess960, fischerandom, crazyhouse, antichess, ...) —
 * варианты, broadcast скрываем.
 */
export function isStandardVariant(variant: string | null): boolean {
  if (variant === null) return true;
  const v = variant.trim().toLowerCase();
  return v === '' || v === 'standard' || v === 'chess' || v === 'classical';
}

@Injectable()
export class BroadcastSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastSyncService.name);

  private pubRedis: Redis | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private pinnedPollTimer: NodeJS.Timeout | null = null;
  private readonly activeStreams = new Map<string, AbortController>();
  private pollOffset = 0;
  private rateLimitBackoffUntil = 0;
  private stopped = false;
  private started = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: SyncMetricsService,
    // KS-2723: для event-driven инвалидации кэша standings при
    // изменении result или появлении новой partii.
    private readonly standingsSync: BroadcastStandingsSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    // ADR-022 §2.6 шаг 0: фича-флаг. Default false — sync не стартует, модуль
    // зарегистрирован, но idle. Шаг 2 cutover'а переключает флаг в env без
    // пересборки образа.
    if (process.env.BROADCAST_SYNC_ENABLED !== 'true') {
      this.logger.log(
        'BROADCAST_SYNC_ENABLED != "true" — sync-loop disabled, HTTP-only mode',
      );
      return;
    }

    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.logger.log(
      `[broadcast-sync] started. Redis=${redisHost}:${redisPort}`,
    );

    // Dedicated pub-клиент: общий RedisService используем для обычных
    // read/write (locks, TTL-ключи), а publish — через отдельное соединение
    // (ADR-021 §2.3 п.3).
    this.pubRedis = new Redis({ host: redisHost, port: redisPort });

    // Clear stale locks from previous instance
    await this.redis.del(SYNC_LOCK_KEY, PINNED_LOCK_KEY).catch(() => {});
    this.logger.log('[broadcast-sync] Cleared stale locks');

    // DB connectivity check
    const dbUrlRaw = process.env.BROADCASTS_DATABASE_URL ?? '';
    const dbUrl = dbUrlRaw.replace(/\/\/[^@]*@/, '//***@');
    this.logger.log(
      `[broadcast-sync] DB URL (BROADCASTS_DATABASE_URL)=${dbUrl}`,
    );
    try {
      const startTs = Date.now();
      await this.prisma.$queryRawUnsafe('SELECT 1');
      this.logger.log(
        `[broadcast-sync] DB reachable (${Date.now() - startTs}ms)`,
      );
    } catch (e: unknown) {
      this.logger.error(
        `[broadcast-sync] DB UNREACHABLE: ${(e as Error).message}`,
      );
    }

    // Lichess API connectivity check
    try {
      const testRes = await fetch('https://lichess.org/api', {
        signal: AbortSignal.timeout(10_000),
      });
      this.logger.log(
        `[broadcast-sync] Lichess API reachable: ${testRes.status}`,
      );
    } catch (e: unknown) {
      const err = e as Error & { cause?: Error };
      this.logger.error(
        `[broadcast-sync] Lichess API UNREACHABLE: ${err.message} cause=${err.cause?.message ?? 'none'}`,
      );
    }

    // KS-2450 (deploy-fix): инициальный sync — fire-and-forget. До этого
    // блокировал OnModuleInit на ~4 минуты (100 broadcasts), из-за чего
    // app.listen() не успевал открыть порт 3004 раньше ALB health-check
    // unhealthy threshold (45s). ECS убивал таск как deadlock, деплой
    // зацикливался на rollback. Стартовый sync теперь идёт в фоне после
    // того как процесс уже слушает порт; periodic sync — как и раньше.
    setImmediate(() => {
      this.syncBroadcasts().catch((e: Error) =>
        this.logger.error(`[broadcast-sync] Initial sync error: ${e.message}`),
      );
    });
    this.syncTimer = setInterval(() => {
      this.syncBroadcasts().catch((e: Error) =>
        this.logger.error(`[broadcast-sync] Sync error: ${e.message}`),
      );
    }, SYNC_INTERVAL_MS);

    setImmediate(() => {
      this.syncPinnedBroadcasts().catch((e: Error) =>
        this.logger.error(
          `[broadcast-sync] Initial pinned poll error: ${e.message}`,
        ),
      );
    });
    this.pinnedPollTimer = setInterval(() => {
      this.syncPinnedBroadcasts().catch((e: Error) =>
        this.logger.error(`[broadcast-sync] PGN poll error: ${e.message}`),
      );
    }, PINNED_POLL_INTERVAL_MS);

    this.logger.log(
      '[broadcast-sync] Running (initial syncs scheduled in background)',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.pinnedPollTimer) clearInterval(this.pinnedPollTimer);

    for (const [roundId, ctrl] of this.activeStreams) {
      ctrl.abort();
      this.logger.log(`[broadcast-sync] Stream aborted for round ${roundId}`);
    }
    this.activeStreams.clear();

    await this.redis.del(SYNC_LOCK_KEY, PINNED_LOCK_KEY).catch(() => {});
    if (this.pubRedis) {
      await this.pubRedis.quit().catch(() => {});
      this.pubRedis = null;
    }
    // PrismaService и RedisService закрываются через собственные
    // OnModuleDestroy — не наша ответственность.
    this.logger.log('[broadcast-sync] Stopped');
  }

  // --- Lichess fetch ---

  private async lichessFetch(url: string, init?: RequestInit): Promise<Response> {
    if (Date.now() < this.rateLimitBackoffUntil) {
      const secsLeft = Math.ceil(
        (this.rateLimitBackoffUntil - Date.now()) / 1000,
      );
      throw new Error(`Lichess 429 backoff active (${secsLeft}s left)`);
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429) {
        this.rateLimitBackoffUntil =
          Date.now() + RATE_LIMIT_429_BACKOFF_TTL * 1000;
        this.logger.warn(
          `[broadcast-sync] Lichess 429 on ${url}. Backing off ${RATE_LIMIT_429_BACKOFF_TTL}s`,
        );
        throw new Error('Lichess 429 Too Many Requests');
      }
      return res;
    } catch (e: unknown) {
      const err = e as Error & { cause?: Error };
      this.logger.error(
        `[broadcast-sync] lichessFetch FAILED url=${url} error=${err.message} cause=${err.cause?.message ?? 'none'}`,
      );
      throw e;
    }
  }

  private rateLimitDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }

  private async acquireLock(key: string, ttlSec: number): Promise<boolean> {
    try {
      const result = await this.redis.set(
        key,
        process.pid.toString(),
        'EX',
        ttlSec,
        'NX',
      );
      return result === 'OK';
    } catch {
      return false;
    }
  }

  // --- Redis pub/sub ---

  private publishMove(
    _roundId: string,
    payload: {
      roundId: string;
      /** KS-2774. UUID партии. null если запись в БД не создана. */
      id: string | null;
      gameIndex: number;
      uci: string;
      fen: string;
      whitePlayer: string;
      blackPlayer: string;
      /** KS-2798. ISO wall-clock этого хода; null если ход не новый. */
      lastMoveAt: string | null;
    },
  ): void {
    if (!this.pubRedis) return;
    this.pubRedis
      .publish(BROADCAST_MOVE_CHANNEL, JSON.stringify(payload))
      .catch((e: Error) =>
        this.logger.error(`[broadcast-sync] Publish move error: ${e.message}`),
      );
  }

  private publishSync(_roundId: string, payload: object): void {
    if (!this.pubRedis) return;
    this.pubRedis
      .publish(BROADCAST_SYNC_CHANNEL, JSON.stringify(payload))
      .catch((e: Error) =>
        this.logger.error(`[broadcast-sync] Publish sync error: ${e.message}`),
      );
  }

  // --- Sync logic ---

  async syncBroadcasts(): Promise<void> {
    if (!(await this.acquireLock(SYNC_LOCK_KEY, SYNC_LOCK_TTL))) {
      this.logger.log(
        '[broadcast-sync] syncBroadcasts: lock not acquired, skipping',
      );
      this.metrics.recordCycle('full', 'skipped');
      return;
    }
    this.logger.log('[broadcast-sync] Syncing broadcasts from Lichess...');
    const startedAt = Date.now();

    try {
      const broadcasts = await this.fetchActiveBroadcasts();
      const currentLichessIds = new Set(broadcasts.map((b) => b.tour.id));

      this.logger.log(
        `[broadcast-sync] Processing ${broadcasts.length} broadcasts...`,
      );
      let fetchCount = 0;
      // KS-2779. Собираем lichessRoundId, которые увидели в top-20 fetch —
      // их статус уже обновлён через upsertRound. Остальные наши раунды
      // (не-top-20 broadcast'ы) обновим отдельным fetcher'ом ниже,
      // чтобы у них тоже status зеркалил Lichess.
      const upsertedRoundIds = new Set<string>();
      for (let idx = 0; idx < broadcasts.length; idx++) {
        const bc = broadcasts[idx];
        this.logger.log(
          `[broadcast-sync] [${idx + 1}/${broadcasts.length}] upsert ${bc.tour.id} "${bc.tour.name}"`,
        );
        try {
          await this.upsertBroadcast(bc);
        } catch (e: unknown) {
          this.logger.error(
            `[broadcast-sync] upsertBroadcast FAILED ${bc.tour.id}: ${(e as Error).message}`,
          );
          continue;
        }
        for (const round of bc.rounds) {
          const isActive = round.ongoing === true;
          let upserted: { status: string } | null = null;
          try {
            upserted = await this.upsertRound(bc.tour.id, round, isActive);
            upsertedRoundIds.add(round.id);
          } catch (e: unknown) {
            this.logger.error(
              `[broadcast-sync] upsertRound FAILED ${round.id}: ${(e as Error).message}`,
            );
            continue;
          }
          const effectiveActive = upserted?.status === 'ongoing';
          if (effectiveActive) {
            if (!this.activeStreams.has(round.id)) {
              if (this.activeStreams.size < MAX_CONCURRENT_STREAMS) {
                this.startStream(round.id);
              }
            }
          }
          // Finished rounds: re-fetch if games have no result or starting FEN
          if (round.finished && fetchCount < MAX_PGN_POLLS_PER_CYCLE) {
            try {
              await this.rateLimitDelay();
              const fetched = await this.fetchFinishedRoundGamesIfEmpty(
                round.id,
              );
              if (fetched) fetchCount++;
            } catch (e: unknown) {
              this.logger.warn(
                `[broadcast-sync] fetchFinishedRoundGamesIfEmpty failed ${round.id}: ${(e as Error).message}`,
              );
            }
          }
        }
      }

      // KS-2779. Зеркало Lichess для не-top-20 broadcast'ов: дёргаем
      // round-metadata индивидуально для наших раундов, статус которых
      // не был обновлён в основном цикле (broadcast вне top-20).
      // Это и закрывает раунды (если Lichess решил так), и переоткрывает
      // (если Lichess вернул ongoing после finished).
      try {
        await this.refreshNonTop20RoundStatuses(upsertedRoundIds);
      } catch (e: unknown) {
        this.logger.warn(
          `[broadcast-sync] refreshNonTop20RoundStatuses failed: ${(e as Error).message}`,
        );
      }

      // KS-2722: используем БД-статус (после override), а не Lichess-флаг,
      // чтобы локально-active round'ы не отабортились зря.
      const activeRoundsInDb = await this.prisma.broadcastRound.findMany({
        where: { status: 'ongoing' },
        select: { lichessRoundId: true },
      });
      const activeRoundIds = new Set(
        activeRoundsInDb.map((r) => r.lichessRoundId),
      );
      for (const [roundId, ctrl] of this.activeStreams) {
        if (!activeRoundIds.has(roundId)) {
          ctrl.abort();
          this.activeStreams.delete(roundId);
        }
      }

      // KS-1700 Part A: маркируем stale broadcasts. Защита от false-negative —
      // выполняем только если fetch вернул хотя бы что-то (пустой top-20 =
      // Lichess не ответил, не надо на его основании архивить свою БД).
      if (broadcasts.length > 0) {
        await this.checkStaleBroadcasts(currentLichessIds);
      } else {
        this.logger.warn(
          '[broadcast-sync] Empty Lichess response — skipping stale check to avoid false-negatives',
        );
      }

      this.metrics.observeDuration('full', (Date.now() - startedAt) / 1000);
      this.metrics.recordCycle('full', 'ok');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      this.logger.error(`[broadcast-sync] Sync failed: ${msg}`);
      this.metrics.observeDuration('full', (Date.now() - startedAt) / 1000);
      this.metrics.recordCycle('full', 'err');
      this.metrics.recordFailure('full', msg.slice(0, 64));
    }
  }

  /**
   * KS-1700 Part A: после N циклов отсутствия broadcast в Lichess top-20 —
   * `isActive=false`. Запись не удаляется, игры и раунды остаются для
   * исторических страниц. При возвращении в top-20 `upsertBroadcast` вернёт
   * `isActive=true`, а счётчик сбросится здесь же (ветка seen).
   *
   * Счётчик живёт в Redis — переживает перезапуск. TTL = N × SYNC_INTERVAL × 2,
   * чтобы между циклами не истёк, но и не накапливался вечно.
   */
  private async checkStaleBroadcasts(
    currentLichessIds: Set<string>,
  ): Promise<void> {
    const staleCycles = parseInt(
      process.env.BROADCAST_STALE_CYCLES ?? String(DEFAULT_STALE_CYCLES),
      10,
    );
    if (isNaN(staleCycles) || staleCycles < 1) {
      this.logger.warn(
        `[broadcast-sync] Invalid BROADCAST_STALE_CYCLES, skipping stale check`,
      );
      return;
    }
    const ttlSeconds = Math.ceil((staleCycles * SYNC_INTERVAL_MS * 2) / 1000);

    await runStaleCheck({
      prisma: this.prisma,
      redis: this.redis,
      currentLichessIds,
      staleCycles,
      ttlSeconds,
      keyPrefix: MISS_COUNT_KEY_PREFIX,
      logger: {
        log: (m) => this.logger.log(m),
        warn: (m) => this.logger.warn(m),
        error: (m) => this.logger.error(m),
      },
    });
  }

  async syncPinnedBroadcasts(): Promise<void> {
    if (!(await this.acquireLock(PINNED_LOCK_KEY, PINNED_LOCK_TTL))) {
      this.logger.log(
        '[broadcast-sync] syncPinnedBroadcasts: lock not acquired, skipping',
      );
      this.metrics.recordCycle('pinned', 'skipped');
      return;
    }

    const startedAt = Date.now();
    try {
      const ongoingRounds = await this.prisma.broadcastRound.findMany({
        where: { status: 'ongoing' },
        select: { lichessRoundId: true },
      });

      // Exclude rounds that already have an active stream — they get data via
      // streaming, no need to poll
      const streamedRoundIds = new Set(this.activeStreams.keys());
      const nonStreamedRounds = ongoingRounds.filter(
        (r) => !streamedRoundIds.has(r.lichessRoundId),
      );

      const toFetch: typeof nonStreamedRounds = [];
      if (nonStreamedRounds.length > 0) {
        this.pollOffset = this.pollOffset % nonStreamedRounds.length;
        const take = Math.min(MAX_PGN_POLLS_PER_CYCLE, nonStreamedRounds.length);
        for (let i = 0; i < take; i++) {
          toFetch.push(
            nonStreamedRounds[
              (this.pollOffset + i) % nonStreamedRounds.length
            ],
          );
        }
        this.pollOffset = (this.pollOffset + take) % nonStreamedRounds.length;
      }

      // KS-2356: summary state of polling queue для диагностики «почему
      // конкретный round долго не получает партии».
      this.logger.log(
        `[broadcast-sync] poll-cycle ongoing=${ongoingRounds.length} ` +
          `streamed=${streamedRoundIds.size} queued=${nonStreamedRounds.length} ` +
          `picked=${toFetch.length} pollOffset=${this.pollOffset}`,
      );

      for (let i = 0; i < toFetch.length; i++) {
        if (i > 0) await this.rateLimitDelay();
        await this.fetchAndProcessRoundPgn(toFetch[i].lichessRoundId).catch(
          (e: Error) =>
            this.logger.warn(
              `[broadcast-sync] PGN poll failed for ${toFetch[i].lichessRoundId}: ${e.message}`,
            ),
        );
      }

      this.metrics.observeDuration('pinned', (Date.now() - startedAt) / 1000);
      this.metrics.recordCycle('pinned', 'ok');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      this.logger.error(`[broadcast-sync] Pinned sync failed: ${msg}`);
      this.metrics.observeDuration('pinned', (Date.now() - startedAt) / 1000);
      this.metrics.recordCycle('pinned', 'err');
      this.metrics.recordFailure('pinned', msg.slice(0, 64));
    }
  }

  private async fetchAndProcessRoundPgn(lichessRoundId: string): Promise<void> {
    const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
    const res = await this.lichessFetch(url, {
      headers: {
        'User-Agent': 'Kingside/1.0 (https://kingside.app)',
        Accept: 'application/x-chess-pgn',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // KS-2356: ранее silent fail — DevOps не видит почему round
      // не получает партии. Логируем status для диагностики.
      this.logger.warn(
        `[broadcast-sync] PGN poll ${lichessRoundId} HTTP ${res.status}`,
      );
      return;
    }
    const pgn = await res.text();
    if (!pgn.trim()) {
      // KS-2356: пустой PGN — round зарегистрирован в Lichess как
      // ongoing, но партии ещё не начались (или результаты не
      // транслируются через PGN-stream). Логируем, чтобы понимать,
      // что round в очереди, но Lichess не отдаёт данные.
      this.logger.log(
        `[broadcast-sync] PGN poll ${lichessRoundId} empty (round ongoing but no PGN data yet)`,
      );
      return;
    }

    const hashKey = `broadcast:pgn-hash:${lichessRoundId}`;
    const newHash = createHash('md5').update(pgn).digest('hex');
    try {
      const prevHash = await this.redis.get(hashKey);
      if (prevHash === newHash) {
        const round = await this.prisma.broadcastRound.findUnique({
          where: { lichessRoundId },
        });
        if (round) {
          const reallyStale = await this.prisma.$queryRaw<
            [{ count: bigint }]
          >`
            SELECT count(*)::bigint as count FROM broadcast_games
            WHERE round_id = ${round.id}::uuid
              AND current_fen = ${STARTING_FEN}
              AND LENGTH(pgn) > 500`;
          if (Number(reallyStale[0].count) === 0) return;
        }
      }
      await this.redis.set(hashKey, newHash, 'EX', PGN_HASH_TTL);
    } catch {
      /* proceed */
    }

    // KS-2722: publishSync теперь живёт внутри `processPgnUpdate`,
    // чтобы streaming-канал тоже доставлял обновлённый snapshot.
    // Здесь дополнительный вызов не нужен.
    await this.processPgnUpdate(lichessRoundId, pgn);
  }

  private async fetchActiveBroadcasts(): Promise<LichessBroadcast[]> {
    // KS-2356: ранее `nb=20` обрезал список Lichess top-20 — на проде
    // не было Mitropa, Ostrava, Marshall и десятков других live-
    // турниров с реальными партиями. Увеличиваем до 100 (max разумный
    // предел Lichess /api/broadcast). Конфигурируется ENV
    // `LICHESS_BROADCAST_NB` для оперативной подстройки без deploy.
    //
    // NB: `MAX_CONCURRENT_STREAMS=50` ограничивает одновременные PGN-
    // стримы — если live-турниров > 50, они стримятся «по очереди»
    // через PGN-poll (5 циклов в минуту). Это не теряет данные, но
    // отдельные раунды могут отставать на несколько минут. Если
    // станет узким местом — поднять MAX_CONCURRENT_STREAMS отдельно.
    const nb = parseInt(process.env.LICHESS_BROADCAST_NB ?? '100', 10);
    const url = `${LICHESS_API}/broadcast?nb=${nb}`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Use a single AbortSignal for both fetch and body read
        const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const res = await this.lichessFetch(url, {
          headers: {
            Accept: 'application/x-ndjson',
            'User-Agent': 'Kingside/1.0 (https://kingside.app)',
          },
          signal,
        });
        if (!res.ok) throw new Error(`Lichess API error: ${res.status}`);
        const text = await res.text(); // signal aborts body read too
        const broadcasts: LichessBroadcast[] = [];
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            broadcasts.push(JSON.parse(trimmed));
          } catch {
            /* skip */
          }
        }
        this.logger.log(
          `[broadcast-sync] Fetched ${broadcasts.length} broadcasts from Lichess (attempt ${attempt + 1})`,
        );
        return broadcasts;
      } catch (e: unknown) {
        lastError = e as Error;
        if (attempt < 2) {
          const delay = (attempt + 1) * 5000;
          this.logger.warn(
            `[broadcast-sync] fetchActiveBroadcasts attempt ${attempt + 1} failed: ${(e as Error).message}. Retry in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error('fetchActiveBroadcasts failed');
  }

  private async upsertBroadcast(bc: LichessBroadcast): Promise<void> {
    const info = bc.tour.info;
    const dates = bc.tour.dates;
    const standingsUrl = info?.standings ?? null;
    // KS-1735 / ADR-023 §2.2.2. Извлекаем chess-results tournament-id из
    // standings_url (если URL ведёт на chess-results). Метрика
    // `crosstable_coverage_total{status}` обновляется на каждой
    // upsertBroadcast — даёт сигнал «достаточно ли > 50% top-20 покрыто
    // chess-results, чтобы фича оправдывала запуск».
    const extracted = extractChessResultsTournamentId(standingsUrl);
    this.metrics.recordCrosstableCoverage(extracted.status, extracted.host);
    if (extracted.status === 'unsupported' && extracted.host) {
      this.logger.log(
        `[broadcast-sync] standings_url unsupported: host=${extracted.host} ` +
          `(broadcast=${bc.tour.id}). Crosstable будет fallback на legacy.`,
      );
    }

    // KS-2474: Lichess не всегда отдаёт `tour.info.format`. Для таких
    // трансляций (Sardinia World Chess Festival 2026 | Open A | 9-round
    // Swiss) format сидит в хвосте `tour.name`. Без явного формата
    // детектор раунда падает на эвристику имени и ложно классифицирует
    // швейцарку как playoff. Fallback извлекает «format-like» сегмент
    // (Swiss / Round Robin / Knockout / elimination / Match).
    const formatFromTitle = info?.format
      ? null
      : extractTournamentFormatFromTitle(bc.tour.name);
    const fields = {
      title: bc.tour.name,
      description: bc.tour.description ?? null,
      url: bc.tour.url ?? null,
      isActive: true,
      format: info?.format ?? formatFromTitle ?? null,
      timeControl: info?.tc ?? null,
      location: info?.location ?? null,
      players: info?.players ?? null,
      website: info?.website ?? null,
      standingsUrl,
      imageUrl: bc.tour.image ?? null,
      startDate: dates?.[0] ? new Date(dates[0]) : null,
      endDate: dates?.[1] ? new Date(dates[1]) : null,
      // KS-1735 — поля для crosstable-фичи (ADR-023 §2.3).
      chessResultsTournamentId: extracted.tournamentId,
      teamTable: bc.tour.teamTable ?? false,
      showTeamScores: bc.tour.showTeamScores ?? false,
    };
    const startTs = Date.now();
    await this.prisma.broadcast.upsert({
      where: { lichessId: bc.tour.id },
      update: fields,
      create: { lichessId: bc.tour.id, ...fields },
    });
    this.logger.log(
      `[broadcast-sync] upsertBroadcast OK: ${bc.tour.id} "${bc.tour.name}" (${Date.now() - startTs}ms)`,
    );
  }

  private async upsertRound(
    broadcastLichessId: string,
    round: LichessRound,
    isActive: boolean,
  ): Promise<{ status: string } | null> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { lichessId: broadcastLichessId },
    });
    if (!broadcast) return null;
    // KS-2779. Зеркалим Lichess 1-в-1. Удалён override KS-2722 «если
    // Lichess finished но локально есть partition '*' → ongoing»: это
    // тоже была наша эвристика. Если Lichess решает что раунд finished
    // — у нас тоже finished. Когда Lichess вернёт ongoing — мы тоже
    // переоткроем (симметрично, без застревания).
    const status = round.finished
      ? 'finished'
      : isActive
        ? 'ongoing'
        : 'pending';
    // KS-1813: предварительный детект типа турнира по name + format (без
    // структуры пар — они появятся только после processPgnUpdate).
    // Окончательный вердикт перезаписывает `classifyRoundBrackets` после
    // каждого PGN-обновления раунда.
    // KS-1847: для командных турниров (`Broadcast.teamTable`) детектор
    // применяет строгий whitelist knockout-маркеров и игнорирует
    // структурный сигнал, чтобы Bundesliga / team-championship не
    // детектились как playoff по словам `final`/`championship`.
    // KS-2474: явный формат (`broadcast.format`, например «9-round Swiss»)
    // имеет высший приоритет над эвристикой имени раунда — иначе
    // швейцарка с раундом «Final Round» ложно классифицируется как
    // playoff. Передаём дополнительно как `tournamentFormat` для
    // явной семантики в callsite-е.
    const tournamentType = detectRoundTournamentType({
      roundName: round.name,
      broadcastFormat: broadcast.format,
      tournamentFormat: broadcast.format,
      isTeamTournament: broadcast.teamTable,
    });
    const upserted = await this.prisma.broadcastRound.upsert({
      where: { lichessRoundId: round.id },
      update: {
        name: round.name,
        startsAt: round.startsAt ? new Date(round.startsAt) : null,
        status,
        tournamentType,
      },
      create: {
        broadcastId: broadcast.id,
        lichessRoundId: round.id,
        name: round.name,
        startsAt: round.startsAt ? new Date(round.startsAt) : null,
        status,
        tournamentType,
      },
    });

    // KS-1819: прогон `classifyRoundBrackets` при каждом sync-цикле раунда —
    // не только после PGN-update. Раньше существующие партии
    // переклассифицировались только когда приходило PGN-обновление, из-за
    // чего уже загруженные playoff-раунды на проде оставались без
    // bracket-полей. `classifyRoundBrackets` идемпотентен — для не-playoff
    // он обнуляет возможные «зомби»-значения через `updateMany`.
    try {
      await classifyRoundBrackets(this.prisma, upserted.id);
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] classifyRoundBrackets(upsertRound) failed for round=${upserted.id.slice(0, 8)}: ${(e as Error).message}`,
      );
    }

    // KS-1824: после того как раунд классифицирован, пересчитываем
    // links между парами на уровне всего броадкаста (advance / loser).
    // Одной пары мало: `winners_semi` может появиться позже, и только
    // увидев обе стадии, `computeAdvanceLinks` сможет связать их.
    try {
      await applyBracketLinks(this.prisma, broadcast.id);
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] applyBracketLinks(upsertRound) failed for broadcast=${broadcast.id.slice(0, 8)}: ${(e as Error).message}`,
      );
    }

    return { status };
  }

  /**
   * KS-2779. Зеркало Lichess для раундов, которые НЕ были обновлены
   * через `upsertRound` (broadcast вне top-20). Для каждого такого
   * раунда дёргаем `/api/broadcast/-/-/{lichessRoundId}`, читаем
   * `round.finished`/`round.ongoing` и проставляем у нас 1-в-1.
   *
   * Обрабатывает раунды в `status IN (ongoing, pending)` и
   * `finished` за последние 7 дней (на случай если Lichess
   * переоткрыл уже-закрытый раунд).
   *
   * Rate-limit: каждый запрос идёт через `lichessFetch` с rate-limit
   * backoff'ом, плюс `rateLimitDelay` между запросами.
   */
  private async refreshNonTop20RoundStatuses(
    upsertedRoundIds: Set<string>,
  ): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.broadcastRound.findMany({
      where: {
        OR: [
          { status: 'ongoing' },
          { status: 'pending' },
          { status: 'finished', updatedAt: { gte: sevenDaysAgo } },
        ],
      },
      select: { id: true, lichessRoundId: true, status: true },
    });

    const toFetch = candidates.filter(
      (r) => !upsertedRoundIds.has(r.lichessRoundId),
    );
    if (toFetch.length === 0) return;

    this.logger.log(
      `[broadcast-sync] refreshNonTop20RoundStatuses: ${toFetch.length} rounds to check`,
    );

    for (const r of toFetch) {
      try {
        await this.rateLimitDelay();
        const url = `${LICHESS_API}/broadcast/-/-/${r.lichessRoundId}`;
        const res = await this.lichessFetch(url, {
          headers: {
            'User-Agent': 'Kingside/1.0 (https://kingside.app)',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          if (res.status === 404) {
            // Lichess удалил round — оставляем как есть, но логируем.
            this.logger.warn(
              `[broadcast-sync] round ${r.lichessRoundId} not found on Lichess (404)`,
            );
          } else {
            this.logger.warn(
              `[broadcast-sync] round-metadata fetch ${r.lichessRoundId} failed: HTTP ${res.status}`,
            );
          }
          continue;
        }
        const body = (await res.json()) as {
          round?: { finished?: boolean; ongoing?: boolean };
        };
        const finished = body.round?.finished === true;
        const ongoing = body.round?.ongoing === true;
        const newStatus = finished ? 'finished' : ongoing ? 'ongoing' : 'pending';
        if (newStatus !== r.status) {
          this.logger.log(
            `[broadcast-sync] round ${r.lichessRoundId} status mirror: ${r.status} → ${newStatus}`,
          );
          await this.prisma.broadcastRound.update({
            where: { id: r.id },
            data: { status: newStatus },
          });
        }
      } catch (e: unknown) {
        this.logger.warn(
          `[broadcast-sync] round-metadata fetch ${r.lichessRoundId} threw: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Returns true if an actual Lichess fetch was performed */
  private async fetchFinishedRoundGamesIfEmpty(
    lichessRoundId: string,
  ): Promise<boolean> {
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId },
    });
    if (!round) return false;

    const staleGames = await this.prisma.broadcastGame.count({
      where: {
        roundId: round.id,
        OR: [{ currentFen: STARTING_FEN }, { result: null }, { result: '*' }],
      },
    });
    const totalGames = await this.prisma.broadcastGame.count({
      where: { roundId: round.id },
    });
    if (totalGames > 0 && staleGames === 0) return false;

    const cooldownKey = `broadcast:pgn-fetch-cooldown:${lichessRoundId}`;
    const cooldown = await this.redis.get(cooldownKey).catch(() => null);
    if (cooldown) return false;

    try {
      const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
      const res = await this.lichessFetch(url, {
        headers: {
          'User-Agent': 'Kingside/1.0 (https://kingside.app)',
          Accept: 'application/x-chess-pgn',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await this.redis
          .set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL)
          .catch(() => {});
        return true;
      }
      const pgn = await res.text();
      if (pgn.trim()) {
        await this.processPgnUpdate(lichessRoundId, pgn);
      } else {
        await this.redis
          .set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL)
          .catch(() => {});
      }
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `[broadcast-sync] PGN fetch error ${lichessRoundId}: ${(e as Error).message}`,
      );
      await this.redis
        .set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL)
        .catch(() => {});
      return true;
    }
  }

  private startStream(roundId: string): void {
    const ctrl = new AbortController();
    this.activeStreams.set(roundId, ctrl);
    this.runStream(roundId, ctrl.signal).then(() => {
      // Stream ended (aborted or stopped) — clean up
      this.activeStreams.delete(roundId);
    });
  }

  private async runStream(
    roundId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const url = `${LICHESS_API}/stream/broadcast/round/${roundId}.pgn`;
    let retryDelay = 2000;
    const maxDelay = 300_000; // 5 minutes — let Lichess rate limit reset

    while (!signal.aborted && !this.stopped) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/x-ndjson' },
          signal,
        });
        if (res.status === 429) {
          this.logger.warn(
            `[broadcast-sync] Stream ${roundId}: 429 rate limited, stopping stream (PGN poll will take over)`,
          );
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        retryDelay = 2000;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (signal.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });
          // Lichess PGN stream separates full updates with triple newline
          const parts = buffer.split('\n\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const pgn = part.trim();
            if (!pgn) continue;
            await this.processPgnUpdate(roundId, pgn);
          }
        }
      } catch (e: unknown) {
        if (signal.aborted) break;
        this.logger.warn(
          `[broadcast-sync] Stream ${roundId} disconnected: ${(e as Error).message}. Retry in ${retryDelay}ms`,
        );
        await this.sleep(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    }
  }

  private async processPgnUpdate(roundId: string, pgn: string): Promise<void> {
    const games = this.parsePgnGames(pgn);
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId: roundId },
    });
    if (!round) {
      this.logger.warn(
        `[broadcast-sync] processPgnUpdate: round ${roundId} not found in DB`,
      );
      return;
    }
    this.logger.log(
      `[broadcast-sync] processPgnUpdate: round=${roundId.slice(0, 8)} games=${games.length} withUci=${games.filter((g) => g.uci).length}`,
    );

    // KS-2780. Извлекаем PGN-header [Variant "..."] — источник правды
    // от Lichess. Если variant non-standard (Chess960, FischerRandom,
    // etc.) — сохраняем у broadcast'а. API guard фильтрует эти
    // broadcast'ы из списка.
    const variant = extractVariantFromPgn(pgn);
    if (variant !== null) {
      const broadcast = await this.prisma.broadcast.findUnique({
        where: { id: round.broadcastId },
        select: { variant: true },
      });
      const normalized = isStandardVariant(variant) ? null : variant;
      if (broadcast && broadcast.variant !== normalized) {
        await this.prisma.broadcast.update({
          where: { id: round.broadcastId },
          data: { variant: normalized },
        });
        this.logger.log(
          `[broadcast-sync] broadcast ${round.broadcastId.slice(0, 8)} variant set: ${normalized ?? 'standard'}`,
        );
      }
    }

    // KS-2723: флаг для event-driven инвалидации кэша standings.
    // Поднимается при появлении нового финального result или новой
    // partии (новый round / новая пара). В конце функции, если флаг
    // взведён — DELETE'аем `broadcast_standings` для broadcast'а
    // round'а; следующий /crosstable пересоберётся с актуальными
    // данными.
    let standingsCacheNeedsInvalidate = false;

    for (const game of games) {
      const isStarting = game.fen === STARTING_FEN;
      this.logger.log(
        `[broadcast-sync] game[${game.index}] ${game.white} vs ${game.black} fen=${isStarting ? 'STARTING' : game.fen.slice(0, 30)} uci=${game.uci || 'NONE'} lichessId=${game.lichessGameId?.slice(0, 8) ?? 'null'} pgnLen=${game.pgn.length}`,
      );
      if (!isStarting) {
        await this.redis
          .set(
            `broadcast:fen:${roundId}:${game.index}`,
            game.fen,
            'EX',
            REDIS_FEN_TTL,
          )
          .catch(() => {});
      }

      // KS-2774. Будем форвардить gameId (UUID) в publishMove —
      // фронту нужно для определения кликабельной партии. Сохраняем id
      // существующей записи либо новой созданной.
      let dbGameId: string | null = null;
      // KS-2798: ISO-8601 момент свежего хода — для payload publishMove,
      // если в этой итерации он реально появился. null означает «нет
      // нового хода в этом update» (повторный PGN-snapshot без новых
      // полуходов).
      let lastMoveAtIsoForPublish: string | null = null;
      if (game.lichessGameId) {
        const existing = await this.prisma.broadcastGame.findFirst({
          where: { roundId: round.id, lichessGameId: game.lichessGameId },
        });

        // KS-2723: трекаем «значимые» изменения, требующие
        // инвалидации кэша standings. Финальный result партии или
        // создание новой partii (новый round-record на фронте) —
        // меняют crosstable, кэш не валиден.
        const isNewFinalResult =
          !!game.result &&
          game.result !== '*' &&
          (!existing ||
            !existing.result ||
            existing.result === '*' ||
            existing.result !== game.result);
        const isNewGame = !existing;
        if (isNewFinalResult || isNewGame) {
          standingsCacheNeedsInvalidate = true;
        }

        // KS-2699 / KS-2720: clocks обновляются только когда хотя бы
        // одна сторона имеет НОВОЕ значение (отличное от уже
        // сохранённого). При совпадении значения с БД timestamp
        // остаётся прежним — иначе при последующем %clk-only-белых
        // обновлении для активной чёрной стороны фронтовый отсчёт
        // сбрасывается, и таймер чёрного «прыгает» (KS-2720 баг).
        const newWhiteBig =
          game.whiteClockMs !== null ? BigInt(game.whiteClockMs) : null;
        const newBlackBig =
          game.blackClockMs !== null ? BigInt(game.blackClockMs) : null;
        const whiteChanged =
          newWhiteBig !== null &&
          existing?.whiteClockMs !== newWhiteBig;
        const blackChanged =
          newBlackBig !== null &&
          existing?.blackClockMs !== newBlackBig;
        const anyChanged = whiteChanged || blackChanged;
        if (anyChanged) {
          this.logger.debug?.(
            `[broadcast-sync] clocks game=${game.lichessGameId.slice(0, 8)} ` +
              `white=${game.whiteClockMs}ms (changed=${whiteChanged}) ` +
              `black=${game.blackClockMs}ms (changed=${blackChanged})`,
          );
        }

        if (existing) {
          dbGameId = existing.id;
          const wouldRegress =
            game.fen === STARTING_FEN &&
            existing.currentFen &&
            existing.currentFen !== STARTING_FEN;
          const newFen = wouldRegress ? existing.currentFen! : game.fen;
          // KS-2798: wall-clock последнего хода. Обновляется когда
          // фактически появился новый полуход — детектится сменой
          // `currentFen` относительно сохранённого значения. Не
          // привязываемся к `%clk`: некоторые источники broadcast'ов
          // его не отдают, а «X минут назад» должно работать всегда.
          // wouldRegress (короткий FEN-сброс от Lichess) — не движение,
          // поэтому ветка под if (!wouldRegress).
          const hasNewMove =
            !wouldRegress &&
            detectLastMoveAt({
              existingFen: existing.currentFen,
              newFen,
              startingFen: STARTING_FEN,
            });
          const lastMoveAt = hasNewMove ? new Date() : null;
          if (lastMoveAt) lastMoveAtIsoForPublish = lastMoveAt.toISOString();
          await this.prisma.broadcastGame.update({
            where: { id: existing.id },
            data: {
              whitePlayer: game.white,
              blackPlayer: game.black,
              whiteElo: game.whiteElo ?? existing.whiteElo,
              blackElo: game.blackElo ?? existing.blackElo,
              result: game.result || null,
              pgn: game.pgn,
              currentFen: newFen,
              // KS-2720: clocks пишем только при изменении хотя бы у
              // одной стороны. Каждое поле обновляется индивидуально
              // (whiteClockMs только если whiteChanged), чтобы не
              // затирать чужое значение null'ом или одним и тем же.
              ...(anyChanged
                ? {
                    ...(whiteChanged ? { whiteClockMs: newWhiteBig } : {}),
                    ...(blackChanged ? { blackClockMs: newBlackBig } : {}),
                    clockUpdatedAt: new Date(),
                  }
                : {}),
              // KS-2798: lastMoveAt — независимо от clocks.
              ...(lastMoveAt ? { lastMoveAt } : {}),
            },
          });
        } else {
          // KS-2798: новая запись с уже сделанными ходами (FEN ≠
          // стартовая) — выставляем lastMoveAt = now(). Если партия
          // создаётся в стартовой позиции (ходов ещё не было), lastMoveAt
          // остаётся null — будет проставлен на первом ходе.
          const hasNewMove = detectLastMoveAt({
            existingFen: null,
            newFen: game.fen,
            startingFen: STARTING_FEN,
          });
          const lastMoveAt = hasNewMove ? new Date() : null;
          if (lastMoveAt) lastMoveAtIsoForPublish = lastMoveAt.toISOString();
          const created = await this.prisma.broadcastGame.create({
            data: {
              roundId: round.id,
              lichessGameId: game.lichessGameId,
              whitePlayer: game.white,
              blackPlayer: game.black,
              whiteElo: game.whiteElo,
              blackElo: game.blackElo,
              result: game.result || null,
              pgn: game.pgn,
              currentFen: game.fen,
              whiteClockMs: newWhiteBig,
              blackClockMs: newBlackBig,
              // Свежее значение хотя бы у одной стороны → ставим
              // текущий timestamp; иначе оставляем null.
              clockUpdatedAt:
                newWhiteBig !== null || newBlackBig !== null
                  ? new Date()
                  : null,
              lastMoveAt,
            },
          });
          dbGameId = created.id;
        }
      }

      // Publish move via Redis pub/sub
      if (game.uci) {
        this.publishMove(round.id, {
          roundId: round.id,
          // KS-2774. UUID партии — для фронта (кликабельные карточки).
          // null если у game нет lichessGameId и записи в БД (редкий
          // edge-case); фронт грейсфолит как ранее (Boolean(game.id)).
          id: dbGameId,
          gameIndex: game.index,
          uci: game.uci,
          fen: game.fen,
          whitePlayer: game.white,
          blackPlayer: game.black,
          // KS-2798: wall-clock этого хода. null когда uci пришёл,
          // но новый полуход не детектирован (повторная отдача того
          // же PGN-snapshot, FEN не изменился).
          lastMoveAt: lastMoveAtIsoForPublish,
        });
      }
    }

    // KS-1813: после обновления игр раунда — пересчитать тип турнира
    // (теперь уже со структурой пар) и, если plаyoff, проставить
    // `bracket_stage` / `bracket_pair_id` / `match_score` на каждую
    // партию. Для round_robin / swiss / unknown bracket-поля обнуляются.
    try {
      await classifyRoundBrackets(this.prisma, round.id);
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] classifyRoundBrackets failed for round=${round.id.slice(0, 8)}: ${(e as Error).message}`,
      );
    }

    // KS-1824: пересчитать связи между парами всего броадкаста после
    // того, как появились новые партии / изменились stage'ы.
    try {
      await applyBracketLinks(this.prisma, round.broadcastId);
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] applyBracketLinks(processPgnUpdate) failed for broadcast=${round.broadcastId.slice(0, 8)}: ${(e as Error).message}`,
      );
    }

    // KS-2779. Удалено локальное закрытие через `shouldCloseRoundAsFinished`
    // (KS-2591). Принцип: Lichess — единственный источник правды для
    // `round.status`. Закрытие/переоткрытие происходит в `upsertRound`
    // и в `refreshRoundStatusFromLichess` строго по `round.finished` /
    // `round.ongoing` от upstream. Локальные эвристики «все partition'ы
    // в БД финальные» удалены — они приводили к преждевременному
    // закрытию когда Lichess добавляет partition'ы постепенно (KS-2777).

    // KS-2722: после каждого PGN-update публикуем full snapshot
    // games через Redis pub/sub. Раньше publishSync вызывался только
    // из `fetchAndProcessRoundPgn` (pinned-poll), а в streaming-режиме
    // (`runStream → processPgnUpdate`) фронт получал только
    // `broadcast:move` без обновлённого `result`. Из-за этого
    // изменение `[Result "1-0"]` после партии не докатывалось до
    // шапки live до следующего sync-цикла.
    try {
      const refreshed = await this.prisma.broadcastRound.findUnique({
        where: { id: round.id },
        include: { games: { orderBy: { updatedAt: 'asc' } } },
      });
      if (refreshed) {
        this.publishSync(refreshed.id, {
          roundId: refreshed.id,
          status: refreshed.status,
          games: refreshed.games.map((g, idx) => ({
            // KS-2772/2774. UUID партии — единственный надёжный ключ
            // для матчинга на фронте между sync-snapshot'ом и move-патчем.
            // `gameIndex` теперь информативный (позиция в массиве sync,
            // отсортированном по updatedAt) и НЕ совпадает с `gameIndex`
            // в `broadcast:move` (где это позиция в LCC-update).
            id: g.id,
            gameIndex: idx,
            fen: g.currentFen ?? STARTING_FEN,
            whitePlayer: g.whitePlayer ?? 'Unknown',
            blackPlayer: g.blackPlayer ?? 'Unknown',
            result: g.result ?? null,
            pgn: g.pgn ?? null,
            // KS-2699: clocks для live-таймера на фронте.
            whiteClockMs:
              g.whiteClockMs !== null && g.whiteClockMs !== undefined
                ? Number(g.whiteClockMs)
                : null,
            blackClockMs:
              g.blackClockMs !== null && g.blackClockMs !== undefined
                ? Number(g.blackClockMs)
                : null,
            clockUpdatedAt: g.clockUpdatedAt
              ? g.clockUpdatedAt.toISOString()
              : null,
            // KS-2798: wall-clock последнего хода (см. schema-comment).
            lastMoveAt: g.lastMoveAt ? g.lastMoveAt.toISOString() : null,
          })),
        });
      }
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] publishSync(processPgnUpdate) failed for round=${round.id.slice(0, 8)}: ${(e as Error).message}`,
      );
    }

    // KS-2723: event-driven инвалидация кэша standings. Если в этом
    // PGN-update появилась новая partia (новый round-record на фронте)
    // или изменился финальный result — DELETE'аем `broadcast_standings`
    // для этого broadcast'а; следующий /crosstable пересоберёт.
    if (standingsCacheNeedsInvalidate) {
      void this.standingsSync.invalidate(round.broadcastId).catch((e) => {
        this.logger.warn(
          `[broadcast-sync] standings.invalidate failed for broadcast=${round.broadcastId.slice(0, 8)}: ${(e as Error).message}`,
        );
      });
    }
  }

  private parsePgnGames(rawPgn: string): ParsedGame[] {
    const cleanedPgn = rawPgn
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            JSON.parse(trimmed);
            return false;
          } catch {
            return true;
          }
        }
        return true;
      })
      .join('\n');

    const gameSections = cleanedPgn.split(/\n\n(?=\[)/);
    const games: ParsedGame[] = [];
    let index = 0;

    for (const section of gameSections) {
      if (!section.trim()) continue;
      const headerMap: Record<string, string> = {};
      const headerLines = section.match(/\[(\w+)\s+"([^"]*)"\]/g) ?? [];
      if (headerLines.length === 0) continue;
      for (const line of headerLines) {
        const m = line.match(/\[(\w+)\s+"([^"]*)"\]/);
        if (m) headerMap[m[1]] = m[2];
      }

      const fenValue = headerMap['FEN'] ?? '';
      const white = headerMap['White'] ?? 'Unknown';
      const black = headerMap['Black'] ?? 'Unknown';
      const whiteElo = this.parseElo(headerMap['WhiteElo']);
      const blackElo = this.parseElo(headerMap['BlackElo']);
      const result = headerMap['Result'] ?? '';
      const lastMove = headerMap['LastMove'] ?? '';
      const site = headerMap['Site'] ?? '';
      const lichessGameId = site.split('/').pop() ?? null;

      const { fen: computedFen, lastUci } = this.computeFenAndLastUci(section);
      const fen = fenValue || computedFen || STARTING_FEN;
      const uci = lastMove || lastUci;

      // KS-2699: clocks извлекаются из %clk-комментариев PGN-секции.
      const { whiteMs, blackMs } = extractClocksFromPgn(section);

      games.push({
        index,
        white,
        black,
        whiteElo,
        blackElo,
        result,
        fen,
        uci,
        pgn: section.trim(),
        lichessGameId: lichessGameId || null,
        whiteClockMs: whiteMs,
        blackClockMs: blackMs,
      });
      index++;
    }
    return games;
  }

  private parseElo(raw: string | undefined): number | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '?' || trimmed === '-') return null;
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n <= 0 || n > 4000) return null;
    return n;
  }

  private computeFenAndLastUci(pgnText: string): {
    fen: string | null;
    lastUci: string;
  } {
    const cleaned = pgnText.replace(/\{[^}]*\}/g, '');
    try {
      const chess = new Chess();
      chess.loadPgn(cleaned);
      const history = chess.history({ verbose: true });
      if (history.length > 0) {
        const last = history[history.length - 1];
        const uci = last.from + last.to + (last.promotion ?? '');
        return { fen: chess.fen(), lastUci: uci };
      }
    } catch {
      /* loadPgn failed */
    }
    return { fen: null, lastUci: '' };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
