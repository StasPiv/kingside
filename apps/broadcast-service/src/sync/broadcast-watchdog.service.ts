/**
 * KS-2158. Watchdog для зависших broadcast-раундов.
 *
 * Контекст: 30.04 пользователь сообщил, что трансляция
 * `a40ab9da-f6f6-453d-bf3a-754382300274` бесконечно висит в /broadcasts как
 * `live`, хотя реально не идёт. Корень: после того как broadcast выпадал
 * из Lichess top-20 и `runStaleCheck` помечал его `isActive=false`,
 * связанные `broadcast_rounds.status='ongoing'` оставались нетронутыми
 * (upsertRound для них больше не вызывался). HTTP `computeBroadcastDetails`
 * проверяет именно `r.status='ongoing'` → трансляция держала
 * `lifecycleStatus='live'`.
 *
 * Этот сервис делает периодическую (раз в минуту по умолчанию) проверку
 * всех `status='ongoing'` раундов и закрывает зависшие. Логика
 * консервативна — закрываем только при явных признаках завершения, чтобы
 * не сорвать live-трансляцию с медленной игрой.
 *
 * Алгоритм одного round'а (ongoing, последний апдейт ≥ STALE_THRESHOLD):
 *   1. Запрашиваем Lichess `GET /api/broadcast/round/{lichessRoundId}.pgn`.
 *   2. 404 → раунд удалён/архивирован → закрываем `finished`.
 *   3. 200 + PGN не содержит `[Result "*"]` (все партии с фактическим
 *      исходом) → закрываем `finished`.
 *   4. 200 + есть `[Result "*"]` → live, медленная игра — НЕ закрываем,
 *      reset fail-counter.
 *   5. 429 / 5xx / network error / timeout → инкремент Redis-счётчика
 *      `broadcast:watchdog:fail-count:<roundId>`. Если ≥
 *      UNREACHABLE_FAIL_THRESHOLD подряд — переводим в `failed` (видно
 *      оператору, что было нештатно). Иначе оставляем как есть, лог warn.
 *
 * Распределённое выполнение: один Redis-lock `broadcast:watchdog:lock`
 * с коротким TTL — если поднято несколько реплик broadcast-service,
 * tick-ает только одна. На SIGKILL TTL истекает за ≤50 с — следующий
 * процесс подхватит без вмешательства.
 *
 * Не использует in-memory state между tick'ами — все счётчики в Redis,
 * переживают рестарт.
 *
 * Конфигурация (env):
 *   BROADCAST_WATCHDOG_ENABLED              default 'false' (фича-флаг)
 *   BROADCAST_WATCHDOG_TICK_MS              default 60_000  (1 мин)
 *   BROADCAST_WATCHDOG_STALE_MIN            default 30      (мин)
 *   BROADCAST_WATCHDOG_UNREACHABLE_THRESHOLD default 3      (consecutive fails)
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const LICHESS_API = 'https://lichess.org/api';

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MIN = 30;
const DEFAULT_UNREACHABLE_FAIL_THRESHOLD = 3;
const LICHESS_TIMEOUT_MS = 10_000;
const FAIL_KEY_TTL_SEC = 4 * 60 * 60; // 4 часа: больше любой adequate-длительности
const FAIL_KEY_PREFIX = 'broadcast:watchdog:fail-count:';
const TICK_LOCK_KEY = 'broadcast:watchdog:lock';
const TICK_LOCK_TTL_SEC = 50; // < tick interval, чтобы повторный tick не пересекался

export type SourceCheckResult =
  | { kind: 'finished'; reason: string }
  | { kind: 'live'; reason: string }
  | { kind: 'unreachable'; reason: string };

export interface StaleRoundCandidate {
  id: string;
  lichessRoundId: string;
  broadcastId: string;
  lastUpdateAt: Date;
}

export interface ProcessOutcome {
  roundId: string;
  outcome:
    | 'closed-finished'
    | 'closed-failed'
    | 'stuck-live'
    | 'stuck-unreachable';
  reason: string;
}

/**
 * Минимальный поверхностный API-фасад, на котором тестируется логика
 * watchdog'а без поднятия PrismaModule/RedisModule.
 */
export interface WatchdogPrisma {
  $queryRawUnsafe<T = unknown>(query: string, ...args: unknown[]): Promise<T>;
  broadcastRound: {
    update(args: {
      where: { id: string };
      data: { status: string };
    }): Promise<unknown>;
  };
  // KS-3332: для tour-API guard перед failed-transition нужно получить
  // lichessId родительского broadcast'а.
  broadcast: {
    findUnique(args: {
      where: { id: string };
      select: { lichessId: true };
    }): Promise<{ lichessId: string } | null>;
  };
}

export interface WatchdogRedis {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttl: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  incr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number | 'OK'>;
  del(key: string): Promise<number>;
}

export interface WatchdogLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface WatchdogDeps {
  prisma: WatchdogPrisma;
  redis: WatchdogRedis;
  logger: WatchdogLogger;
  /** Подменяемый fetch для тестов. Default — global fetch. */
  fetchFn?: typeof fetch;
  /** Подменяемый now() для тестов. */
  now?: () => number;
  staleThresholdMin?: number;
  unreachableFailThreshold?: number;
}

/**
 * Чистая функция-«ядро» watchdog'а — без NestJS-зависимостей.
 * Берёт кандидатов из БД, пробивает Lichess-источник для каждого,
 * пишет финальное решение в БД и Redis. Возвращает summary для логов.
 *
 * Тестируется напрямую через подменяемые `fetchFn` / `prisma` / `redis`,
 * без cron'а.
 */
export async function runWatchdogTick(deps: WatchdogDeps): Promise<{
  scanned: number;
  outcomes: ProcessOutcome[];
}> {
  const staleMin = deps.staleThresholdMin ?? DEFAULT_STALE_THRESHOLD_MIN;
  const unreachableThreshold =
    deps.unreachableFailThreshold ?? DEFAULT_UNREACHABLE_FAIL_THRESHOLD;
  const fetchFn = deps.fetchFn ?? fetch;

  const candidates = await findStaleCandidates(deps.prisma, staleMin);
  const outcomes: ProcessOutcome[] = [];

  for (const round of candidates) {
    const sourceState = await checkLichessRound(
      round.lichessRoundId,
      fetchFn,
      deps.logger,
    );
    const outcome = await applyDecision(
      deps,
      round,
      sourceState,
      unreachableThreshold,
    );
    outcomes.push(outcome);
  }

  return { scanned: candidates.length, outcomes };
}

/**
 * Находит ongoing-раунды, у которых последний апдейт (max(updatedAt)
 * по связанным играм; fallback — broadcasts.updated_at) старше N минут.
 */
async function findStaleCandidates(
  prisma: WatchdogPrisma,
  staleMin: number,
): Promise<StaleRoundCandidate[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      lichess_round_id: string;
      broadcast_id: string;
      last_update_at: Date;
    }>
  >(
    `SELECT * FROM (
       SELECT r.id::text AS id,
              r.lichess_round_id,
              r.broadcast_id::text AS broadcast_id,
              COALESCE(
                (SELECT MAX(g.updated_at) FROM broadcast_games g WHERE g.round_id = r.id),
                b.updated_at
              ) AS last_update_at
         FROM broadcast_rounds r
         JOIN broadcasts b ON b.id = r.broadcast_id
        WHERE r.status = 'ongoing'
     ) sub
     WHERE last_update_at < NOW() - make_interval(mins => $1::int)`,
    staleMin,
  );

  return rows.map((r) => ({
    id: r.id,
    lichessRoundId: r.lichess_round_id,
    broadcastId: r.broadcast_id,
    lastUpdateAt: new Date(r.last_update_at),
  }));
}

/**
 * Запрашивает Lichess `/api/broadcast/round/{id}.pgn` и решает, в каком
 * состоянии источник.
 *   - 404                         → `finished` (раунд удалён или архивирован)
 *   - 200 + нет `[Result "*"]`    → `finished` (все партии завершены)
 *   - 200 + есть `[Result "*"]`   → `live` (есть продолжающиеся партии)
 *   - 429 / 5xx / timeout / err   → `unreachable`
 */
async function checkLichessRound(
  lichessRoundId: string,
  fetchFn: typeof fetch,
  logger: WatchdogLogger,
): Promise<SourceCheckResult> {
  const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Kingside/1.0 (https://kingside.app)',
        Accept: 'application/x-chess-pgn',
      },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return { kind: 'finished', reason: 'lichess 404 (round removed or archived)' };
    }
    if (res.status === 429) {
      return { kind: 'unreachable', reason: 'lichess 429 rate limit' };
    }
    if (res.status >= 500) {
      return { kind: 'unreachable', reason: `lichess HTTP ${res.status}` };
    }
    if (!res.ok) {
      // 4xx (кроме 404) — не транзиентно, но и не «закончилось». Считаем
      // unreachable (повторим, не закрываем) — конкретные коды разберём
      // если появятся в проде.
      return { kind: 'unreachable', reason: `lichess HTTP ${res.status}` };
    }
    const pgn = await res.text();
    if (!pgn.trim()) {
      // Пустой PGN на 200 — у lichess это значит «раунд есть, но партий
      // ещё нет». Считаем `live` (он формально продолжается), watchdog
      // оставляет в покое — закроется по 404 когда его реально удалят.
      return { kind: 'live', reason: '200 with empty PGN' };
    }
    const hasOngoing = /\[Result\s+"\*"\]/.test(pgn);
    if (hasOngoing) {
      return { kind: 'live', reason: 'PGN contains games with [Result "*"]' };
    }
    return { kind: 'finished', reason: 'all games have final result' };
  } catch (err) {
    logger.warn(
      `[broadcast-watchdog] lichess fetch error for ${lichessRoundId}: ${(err as Error).message}`,
    );
    return { kind: 'unreachable', reason: (err as Error).message };
  }
}

/**
 * KS-3332. Tour-API guard: запрашиваем `/api/broadcast/{tourId}` (тонкий
 * JSON по броадкасту со всеми round'ами и их флагами `ongoing/finished`).
 * Возвращает:
 *   - `ongoing`              — Lichess сам говорит этот round `ongoing: true`.
 *   - `finished-or-unknown`  — round есть и НЕ ongoing (finished, pending,
 *                              отсутствует — пусть watchdog продолжит как
 *                              обычно с PGN-based решением).
 *   - `fetch-failed`         — не смогли получить tour-API (network / 429 /
 *                              timeout). По безопасности возвращаем как
 *                              `finished-or-unknown` через caller, чтобы
 *                              fail-transition сохранил поведение.
 *
 * Один extra-fetch за tick на failed-кандидата — не нагрузка (tour-API
 * лёгкий, ~5KB JSON, без rate-limit для read-only).
 */
async function checkRoundStatusInTour(
  tourLichessId: string,
  lichessRoundId: string,
  fetchFn: typeof fetch,
  logger: WatchdogLogger,
): Promise<'ongoing' | 'finished-or-unknown' | 'fetch-failed'> {
  const url = `${LICHESS_API}/broadcast/${tourLichessId}`;
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Kingside/1.0 (https://kingside.app)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        `[broadcast-watchdog] tour-API ${tourLichessId} returned HTTP ${res.status}`,
      );
      return 'fetch-failed';
    }
    const payload = (await res.json()) as {
      rounds?: Array<{
        id?: string;
        ongoing?: boolean;
        finished?: boolean;
      }>;
    };
    if (!payload || !Array.isArray(payload.rounds)) return 'fetch-failed';
    const r = payload.rounds.find((x) => x?.id === lichessRoundId);
    if (!r) return 'finished-or-unknown';
    if (r.ongoing === true) return 'ongoing';
    return 'finished-or-unknown';
  } catch (err) {
    logger.warn(
      `[broadcast-watchdog] tour-API fetch failed for ${tourLichessId}: ${(err as Error).message}`,
    );
    return 'fetch-failed';
  }
}

/**
 * Применяет решение к round'у: либо UPDATE status, либо инкремент
 * fail-counter, либо reset на live.
 */
async function applyDecision(
  deps: WatchdogDeps,
  round: StaleRoundCandidate,
  source: SourceCheckResult,
  unreachableThreshold: number,
): Promise<ProcessOutcome> {
  const { prisma, redis, logger } = deps;
  const failKey = FAIL_KEY_PREFIX + round.id;

  if (source.kind === 'finished') {
    await prisma.broadcastRound.update({
      where: { id: round.id },
      data: { status: 'finished' },
    });
    await redis.del(failKey).catch(() => {});
    logger.warn(
      `broadcast watchdog: round ${round.id} closed (status=finished, source: ${source.reason})`,
    );
    return {
      roundId: round.id,
      outcome: 'closed-finished',
      reason: source.reason,
    };
  }

  if (source.kind === 'live') {
    await redis.del(failKey).catch(() => {});
    logger.log(
      `broadcast watchdog: round ${round.id} stale-but-source-live (${source.reason}) — leave open`,
    );
    return {
      roundId: round.id,
      outcome: 'stuck-live',
      reason: source.reason,
    };
  }

  // unreachable
  let fails = 1;
  try {
    fails = await redis.incr(failKey);
    if (fails === 1) {
      await redis.expire(failKey, FAIL_KEY_TTL_SEC).catch(() => {});
    }
  } catch (err) {
    logger.warn(
      `[broadcast-watchdog] redis incr failed for ${failKey}: ${(err as Error).message}`,
    );
  }

  if (fails >= unreachableThreshold) {
    // KS-3332: ДО transition в failed — guard через tour-API. PGN-stream
    // конкретного round'а у Lichess может быть 429-throttled / network
    // flap, при этом сам round в tour-API `/api/broadcast/{tourId}` всё
    // ещё `ongoing: true`. Если так — НЕ закрываем round (это false-
    // positive, race c main-sync который через минуту опять поставит
    // ongoing). Прод-баг: 39. Internationale Haßlocher Schachtage,
    // Runde 6 мерцал между failed и ongoing.
    let tourCheck: 'ongoing' | 'finished-or-unknown' | 'fetch-failed' =
      'fetch-failed';
    try {
      const bc = await prisma.broadcast.findUnique({
        where: { id: round.broadcastId },
        select: { lichessId: true },
      });
      if (bc?.lichessId) {
        tourCheck = await checkRoundStatusInTour(
          bc.lichessId,
          round.lichessRoundId,
          deps.fetchFn ?? fetch,
          logger,
        );
      }
    } catch (err) {
      logger.warn(
        `[broadcast-watchdog] tour-API guard failed for ${round.id}: ${(err as Error).message}`,
      );
    }
    if (tourCheck === 'ongoing') {
      logger.warn(
        `broadcast watchdog: SKIP failed-transition for ${round.id} — ` +
          `PGN unreachable ${fails}× но tour-API говорит ongoing ` +
          `(false-positive, race c main-sync). Reason: ${source.reason}`,
      );
      // Сбрасываем fail-counter — даём watchdog'у начать заново через час
      // если ситуация повторится. НЕ DEL чтобы не давать infinite loop
      // (failed-fetch x3 → reset → x3 → reset → ...) на постоянном 429.
      // Просто оставляем как есть; fail-key истечёт сам по TTL=4h.
      return {
        roundId: round.id,
        outcome: 'stuck-unreachable',
        reason: `unreachable ${fails}× but tour-API says ongoing (skip failed)`,
      };
    }
    await prisma.broadcastRound.update({
      where: { id: round.id },
      data: { status: 'failed' },
    });
    await redis.del(failKey).catch(() => {});
    logger.warn(
      `broadcast watchdog: round ${round.id} closed (status=failed, source unreachable for ${fails} consecutive checks: ${source.reason})`,
    );
    return {
      roundId: round.id,
      outcome: 'closed-failed',
      reason: `unreachable ${fails}× (${source.reason})`,
    };
  }

  logger.warn(
    `broadcast watchdog: round ${round.id} stuck — source unreachable (fails=${fails}, ${source.reason})`,
  );
  return {
    roundId: round.id,
    outcome: 'stuck-unreachable',
    reason: source.reason,
  };
}

/**
 * NestJS-обёртка с cron'ом. Тонкий слой над `runWatchdogTick`.
 */
@Injectable()
export class BroadcastWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastWatchdogService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.BROADCAST_WATCHDOG_ENABLED !== 'true') {
      this.logger.log(
        'BROADCAST_WATCHDOG_ENABLED != "true" — watchdog disabled',
      );
      return;
    }
    const tickMs = parseTickIntervalMs();
    this.logger.log(
      `[broadcast-watchdog] starting, tickIntervalMs=${tickMs}, ` +
        `staleMin=${parseStaleThresholdMin()}, unreachableThreshold=${parseUnreachableThreshold()}`,
    );
    // Первый tick — после небольшой задержки, чтобы дать sync-сервису
    // подняться (он на onModuleInit делает initial syncBroadcasts()).
    setTimeout(() => void this.tickSafe(), 30_000).unref();
    this.timer = setInterval(() => void this.tickSafe(), tickMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tickSafe(): Promise<void> {
    if (this.stopped) return;
    if (!(await this.acquireLock())) {
      // KS-2591: другой instance держит lock — пропускаем тик. Раньше
      // ветка была silent return, из-за чего «watchdog молчит» нельзя
      // было отличить от «watchdog не запущен» (полная тишина в логах
      // в обоих случаях). Лог на уровне `log` без debounce — нормально
      // для нескольких реплик.
      this.logger.log(
        '[broadcast-watchdog] tick skipped (lock held by other replica)',
      );
      return;
    }
    const start = Date.now();
    try {
      const result = await runWatchdogTick({
        prisma: this.prisma as unknown as WatchdogPrisma,
        redis: this.redis as unknown as WatchdogRedis,
        logger: {
          log: (m) => this.logger.log(m),
          warn: (m) => this.logger.warn(m),
          error: (m) => this.logger.error(m),
        },
        staleThresholdMin: parseStaleThresholdMin(),
        unreachableFailThreshold: parseUnreachableThreshold(),
      });

      const closedFinished = result.outcomes.filter(
        (o) => o.outcome === 'closed-finished',
      ).length;
      const closedFailed = result.outcomes.filter(
        (o) => o.outcome === 'closed-failed',
      ).length;
      const stuckLive = result.outcomes.filter(
        (o) => o.outcome === 'stuck-live',
      ).length;
      const stuckUnreachable = result.outcomes.filter(
        (o) => o.outcome === 'stuck-unreachable',
      ).length;

      this.logger.log(
        `broadcast watchdog: tick scanned=${result.scanned} ` +
          `closedFinished=${closedFinished} closedFailed=${closedFailed} ` +
          `stuckLive=${stuckLive} stuckUnreachable=${stuckUnreachable} ` +
          `durationMs=${Date.now() - start}`,
      );
    } catch (err) {
      this.logger.error(
        `[broadcast-watchdog] tick failed: ${(err as Error).message}`,
      );
    }
    // lock не release-им — пусть истечёт по TTL естественно. Это
    // двойная защита от перекрытия двух tick'ов на медленном Lichess.
  }

  private async acquireLock(): Promise<boolean> {
    try {
      const r = await this.redis.set(
        TICK_LOCK_KEY,
        process.pid.toString(),
        'EX',
        TICK_LOCK_TTL_SEC,
        'NX',
      );
      return r === 'OK';
    } catch {
      return false;
    }
  }
}

function parseEnvInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function parseTickIntervalMs(): number {
  return parseEnvInt('BROADCAST_WATCHDOG_TICK_MS', DEFAULT_TICK_INTERVAL_MS);
}

function parseStaleThresholdMin(): number {
  return parseEnvInt(
    'BROADCAST_WATCHDOG_STALE_MIN',
    DEFAULT_STALE_THRESHOLD_MIN,
  );
}

function parseUnreachableThreshold(): number {
  return parseEnvInt(
    'BROADCAST_WATCHDOG_UNREACHABLE_THRESHOLD',
    DEFAULT_UNREACHABLE_FAIL_THRESHOLD,
  );
}
