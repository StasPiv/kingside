/**
 * KS-3231. Метрика «партий в раунде у нас меньше чем у lichess».
 *
 * Раннее обнаружение регрессий импорта (например, KS-3229: у broadcast
 * Romania в каждом раунде была 1 партия вместо 5, заметили только когда
 * пользователь пожаловался). Cron-задача обходит активные broadcast'ы,
 * сравнивает количество партий в БД с тем, что отдаёт Lichess PGN, и
 * при mismatch шлёт одно агрегированное telegram-сообщение.
 *
 * Архитектурно по образцу `BroadcastWatchdogService`:
 *   - чистая функция `runGameCountCheckTick({prisma,redis,fetchFn,
 *     telegramFn,logger,...})` — для тестов;
 *   - NestJS-обёртка с cron, Redis-lock, env-флагом.
 *
 * Дедупликация: после успешного алерта по паре (broadcastId, roundId)
 * выставляется Redis-ключ `broadcast:metric:alerted:{bid}:{rid}` с TTL
 * 1 час — повторно не дёргаем пока mismatch держится. Если через час
 * mismatch ещё есть — снова пинаем (значит реально надолго залипло).
 *
 * Конфигурация (env):
 *   BROADCAST_GAME_COUNT_CHECK_ENABLED     default 'false'
 *   BROADCAST_GAME_COUNT_CHECK_TICK_MS     default 600_000 (10 мин)
 *   BROADCAST_GAME_COUNT_ALERT_TTL_SEC     default 3600 (1 час)
 *   BROADCAST_GAME_COUNT_MAX_BROADCASTS    default 20 (top-N активных)
 *   TELEGRAM_BOT_TOKEN                     (без него telegram отключен)
 *   BROADCAST_ALERT_TELEGRAM_CHAT_ID       (без него telegram отключен)
 *
 * Если telegram-env не задан — cron всё равно работает и пишет mismatch'и
 * в логи (warn). Полезно для долгосрочной аналитики в Loki/CloudWatch.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BroadcastSyncService } from './broadcast-sync.service';

const LICHESS_API = 'https://lichess.org/api';

const DEFAULT_TICK_INTERVAL_MS = 600_000; // 10 минут
const DEFAULT_ALERT_TTL_SEC = 3600; // 1 час
// KS-3264: cooldown между авто-resync'ами одного и того же раунда.
// Защищает Lichess от спама запросов, если mismatch остаётся после
// resync (Lichess отдал partial, ждём следующий полный snapshot).
// Используется как TTL для FIRST attempt'а (failures=1).
const DEFAULT_AUTO_RESYNC_COOLDOWN_SEC = 3600;
/**
 * KS-3265 (extension). Grace TTL для failures-counter после успешного
 * auto-resync'а. Раньше на success мы DEL'или счётчик — серия мгновенно
 * закрывалась, и любая последующая неудача (flap «success → fail» в
 * течение минут) считалась НОВОЙ серией → отправляла telegram.
 *
 * Теперь на success делаем EXPIRE counter'а на `SUCCESS_GRACE_SEC` (10
 * мин по умолчанию). Если в течение grace происходит новая неудача —
 * INCR счётчика даёт `failuresCount >= 2`, что отрабатывает по той же
 * silenced-логике. После grace-окна счётчик исчезает естественно,
 * серия закрывается, новые неудачи начинают новую серию.
 *
 * Cooldown-ключ на success ВСЁ ЕЩЁ DEL'ится — нужно дать механизму
 * возможность сразу retry'нуть, если Lichess дотечёт ещё партий через
 * минуту. Только counter получает grace.
 */
const DEFAULT_AUTO_RESYNC_SUCCESS_GRACE_SEC = 600;
const AUTO_RESYNC_KEY_PREFIX = 'broadcast:auto-resync:cooldown:';

// KS-3265: эскалирующий cooldown для persistent-failed раундов.
// При повторных fetched=false TTL растёт по таблице, telegram замолкает
// после первой неудачи в серии. Сбрасывается на любой успех (либо при
// исчезновении mismatch'а из metric'а — когда counter тоже expires).
//
// Failures-counter: `broadcast:auto-resync:failures:{lichessRoundId}` →
// INCR на каждой неудаче, EXPIRE syncнут с cooldown'ом. Когда cooldown
// истечёт — counter тоже исчезнет, серия начнётся заново.
const FAILURES_KEY_PREFIX = 'broadcast:auto-resync:failures:';
// Таблица «номер неудачи → cooldown TTL в секундах». Index 0 — первая
// неудача (1ч), index 1 — вторая (3ч), index 2 — третья (12ч), всё что
// дальше — 24ч.
const DEFAULT_FAILURE_COOLDOWN_LADDER_SEC = [3600, 10800, 43200, 86400];
// KS-3256: поднял с 20 до 50. На 20 metric покрывал только 20×15=300
// строк (ORDER BY b.updated_at DESC) — это давало срез топ-53 broadcast'а
// в первом tick, остальные ~230 активных были невидимы. Полный скан
// нашёл 180 mismatches (vs metric видел 23). 50 × 15 = 750 строк ≈
// 50 broadcast'ов × ~15 раундов — покрывает практически все active
// broadcast'ы на сегодня. Дальше можно повышать, но bottleneck — PGN-
// fetch Lichess (1.5с rate-limit на запрос); при 1000 строк tick
// займёт ~25 мин и упрётся в TICK_LOCK_KEY (50с TTL) только если
// разделить tick на под-задачи (KS-3257, если понадобится).
const DEFAULT_MAX_BROADCASTS = 50;
const LICHESS_TIMEOUT_MS = 15_000;
const LICHESS_RATE_LIMIT_DELAY_MS = 1500;
const ALERT_KEY_PREFIX = 'broadcast:metric:alerted:';
const TICK_LOCK_KEY = 'broadcast:metric-check:lock';
const TICK_LOCK_TTL_SEC = 50;

export interface RoundMismatch {
  broadcastId: string;
  broadcastTitle: string;
  lichessBroadcastId: string;
  roundId: string;
  lichessRoundId: string;
  roundName: string;
  ourCount: number;
  lichessCount: number;
}

export interface MetricCheckPrisma {
  $queryRawUnsafe<T = unknown>(query: string, ...args: unknown[]): Promise<T>;
}

export interface MetricCheckRedis {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttl: number,
    nx?: 'NX',
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  // KS-3265: счётчик failures для эскалирующего cooldown'а.
  incr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number | 'OK'>;
  del(key: string): Promise<number>;
}

export interface MetricCheckLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface MetricCheckDeps {
  prisma: MetricCheckPrisma;
  redis: MetricCheckRedis;
  logger: MetricCheckLogger;
  /** Подменяемый fetch для тестов. */
  fetchFn?: typeof fetch;
  /**
   * Подменяемая telegram-отправка. Дефолт — Bot API через fetch.
   * Возвращает true при успехе, false при ошибке (cron не падает).
   * Если bot-token/chat-id не сконфигурированы — функция должна
   * вернуть false и не пытаться слать.
   */
  telegramFn?: (text: string) => Promise<boolean>;
  /** Подменяемый sleep для тестов. */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * KS-3264. Резолвер авто-resync — вызывает
   * `BroadcastSyncService.forceResyncRound(lichessRoundId)`. NestJS-
   * обёртка `BroadcastGameCountMetricService` инжектирует SyncService
   * и передаёт сюда метод. В тестах — подменяемый mock.
   *
   * Возвращает `{fetched, gamesBefore, gamesAfter}` от force-resync.
   * Если throw — расценивается как ошибка, идёт в telegram.
   */
  autoResyncFn?: (lichessRoundId: string) => Promise<{
    fetched: boolean;
    gamesBefore: number;
    gamesAfter: number;
  }>;
  alertTtlSec?: number;
  maxBroadcasts?: number;
  /**
   * KS-3264. Cooldown между авто-resync'ами одного раунда — используется
   * только для FIRST attempt'а (failures=1). Дальше — KS-3265 ladder.
   */
  autoResyncCooldownSec?: number;
  /**
   * KS-3265. Таблица эскалирующего cooldown'а по номеру неудачи в серии.
   * `failures=1 → ladder[0]`, `failures=2 → ladder[1]`, ..., после
   * последнего индекса — последнее значение применяется ко всем
   * следующим. Default `[3600, 10800, 43200, 86400]` (1ч → 3ч → 12ч → 24ч).
   */
  failureCooldownLadderSec?: number[];
  /**
   * KS-3265 (extension). Grace TTL для failures-counter после success.
   * Default 600s (10 мин). Env-override:
   * `BROADCAST_AUTO_RESYNC_SUCCESS_GRACE_SEC`.
   */
  successGraceSec?: number;
}

export interface MetricCheckSummary {
  scannedBroadcasts: number;
  scannedRounds: number;
  mismatches: RoundMismatch[];
  newAlerts: RoundMismatch[];
  telegramSent: boolean;
  /** KS-3264 / KS-3265: статистика авто-resync. */
  autoResyncStats: {
    attempted: number;
    succeeded: number; // gamesAfter ≥ lichess
    persistentMismatches: number; // resync прошёл, но всё ещё < lichess
    errors: number; // throw / fetched=false
    skippedByCooldown: number; // ключ NX не приобретён
    // KS-3265: failure произошёл, но telegram не послан — потому что
    // counter > 1 (повтор в той же серии). Отделено от `errors` —
    // помогает в логах отличить «новый сбой» от «продолжается».
    silencedByRetryLimit: number;
  };
}

/** KS-3264: запись об ошибке авто-resync для telegram-summary. */
interface AutoResyncFailure {
  mismatch: RoundMismatch;
  kind: 'error' | 'persistent';
  reason: string;
  gamesBefore?: number;
  gamesAfter?: number;
}

/**
 * Чистая функция-«ядро» tick'а: сканирует активные broadcast'ы,
 * сравнивает количество партий с Lichess, выставляет alert-ключи,
 * шлёт telegram при новых mismatch'ах. Возвращает summary.
 *
 * Все БД/сеть/telegram — через `deps`; никаких глобальных зависимостей.
 */
export async function runGameCountCheckTick(
  deps: MetricCheckDeps,
): Promise<MetricCheckSummary> {
  const fetchFn = deps.fetchFn ?? fetch;
  const telegramFn = deps.telegramFn ?? (() => Promise.resolve(false));
  const sleepFn =
    deps.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const alertTtl = deps.alertTtlSec ?? DEFAULT_ALERT_TTL_SEC;
  const maxBroadcasts = deps.maxBroadcasts ?? DEFAULT_MAX_BROADCASTS;

  // Активные broadcast'ы с их раундами (только не-pending — у pending
  // партий быть не должно). roundId = наш UUID, lichessRoundId — id для
  // Lichess-запросов. our_count — количество партий уже импортированных.
  // KS-3252: в `broadcasts` нет колонки `slug` (см. packages/broadcasts-db
  // schema.prisma — поля `title`, `lichess_id`, `url`, и т.д., но не slug).
  // Раньше в SQL стоял `b.slug AS broadcast_slug` — postgres валил весь
  // tick'ом ошибкой `42703 column b.slug does not exist`, метрика не
  // работала. Убираем поле — оно нигде не использовалось дальше первого
  // mapping'а, telegram-сообщение строится по title + lichess_id.
  const rows = await deps.prisma.$queryRawUnsafe<
    Array<{
      broadcast_id: string;
      broadcast_title: string;
      lichess_broadcast_id: string;
      round_id: string;
      lichess_round_id: string;
      round_name: string;
      our_count: bigint;
    }>
  >(
    // KS-3254: фильтр по variant. В `broadcasts.variant` (KS-2780)
    // лежит lower-case значение `[Variant "..."]` PGN-header'а от
    // Lichess; NULL значит стандартные шахматы. Non-standard (chess960,
    // fischerandom, crazyhouse, antichess, ...) — наш viewer их не
    // поддерживает, api guard их фильтрует из списка broadcast'ов, и
    // PGN partii в БД мы не пишем (broadcast-record есть, games нет).
    // Без этого фильтра TCEC Fischer Random Chess (chess960) выдавал
    // 9 mismatches за tick. Исключаем такие из метрики целиком.
    `SELECT b.id::text          AS broadcast_id,
            b.title             AS broadcast_title,
            b.lichess_id        AS lichess_broadcast_id,
            r.id::text          AS round_id,
            r.lichess_round_id  AS lichess_round_id,
            r.name              AS round_name,
            COALESCE(
              (SELECT COUNT(*) FROM broadcast_games g WHERE g.round_id = r.id),
              0
            )                   AS our_count
       FROM broadcasts b
       JOIN broadcast_rounds r ON r.broadcast_id = b.id
      WHERE b.is_active = TRUE
        AND r.status IN ('ongoing', 'finished')
        AND (b.variant IS NULL OR b.variant = 'standard')
      ORDER BY b.updated_at DESC, r.starts_at ASC
      LIMIT $1::int`,
    maxBroadcasts * 15, // примерно по 15 раундов на broadcast
  );

  const scannedBroadcasts = new Set(rows.map((r) => r.broadcast_id)).size;
  const mismatches: RoundMismatch[] = [];
  let firstFetchInTick = true;

  for (const row of rows) {
    // rate-limit gap между Lichess-запросами (общий лимит 20 req/s,
    // у нас ≪, но всё же — мы делим quota с основным sync-loop'ом).
    if (!firstFetchInTick) await sleepFn(LICHESS_RATE_LIMIT_DELAY_MS);
    firstFetchInTick = false;

    const lichessCount = await fetchLichessRoundGameCount(
      row.lichess_round_id,
      fetchFn,
      deps.logger,
    );
    if (lichessCount === null) continue; // не достучались, тихо скип

    const ourCount = Number(row.our_count);
    if (ourCount >= lichessCount) continue; // всё ок, у нас не меньше

    mismatches.push({
      broadcastId: row.broadcast_id,
      broadcastTitle: row.broadcast_title,
      lichessBroadcastId: row.lichess_broadcast_id,
      roundId: row.round_id,
      lichessRoundId: row.lichess_round_id,
      roundName: row.round_name,
      ourCount,
      lichessCount,
    });
  }

  // Лог всех mismatch'ей (включая cooldowned, для долгосрочной аналитики).
  for (const m of mismatches) {
    deps.logger.warn(
      `[broadcast-metric] MISMATCH broadcast="${m.broadcastTitle}" ` +
        `(lichess=${m.lichessBroadcastId}) round="${m.roundName}" ` +
        `our=${m.ourCount} lichess=${m.lichessCount}`,
    );
  }

  // KS-3264. Авто-resync вместо telegram-алерта на mismatch. Каждый
  // расходящийся раунд получает попытку `forceResyncRound` (с cooldown
  // 1 час на raunday, чтобы не долбить Lichess в случае persistent-
  // ошибки). Telegram остаётся только для ошибок resync — администратор
  // вмешается только когда автомата не справился.
  const autoResyncCooldown =
    deps.autoResyncCooldownSec ?? DEFAULT_AUTO_RESYNC_COOLDOWN_SEC;
  const ladder =
    deps.failureCooldownLadderSec ?? DEFAULT_FAILURE_COOLDOWN_LADDER_SEC;
  const successGraceSec =
    deps.successGraceSec ?? DEFAULT_AUTO_RESYNC_SUCCESS_GRACE_SEC;
  const autoResyncFn = deps.autoResyncFn;
  const stats = {
    attempted: 0,
    succeeded: 0,
    persistentMismatches: 0,
    errors: 0,
    skippedByCooldown: 0,
    silencedByRetryLimit: 0,
  };
  const failures: AutoResyncFailure[] = [];
  // KS-3264: newAlerts больше не имеет прямой связи с telegram-алертом
  // (тот теперь идёт только на failures). Оставляем массив для обратной
  // совместимости с тестами/каллерами: фиксируем сюда mismatches с
  // которых сняли cooldown и которые попали в auto-resync attempt.
  const newAlerts: RoundMismatch[] = [];

  if (!autoResyncFn) {
    // Нет резолвера — нечего auto-resync'ить. Логируем и возвращаем
    // как раньше (тоже что было до KS-3264, для тестов).
    deps.logger.warn(
      `[broadcast-metric] no autoResyncFn provided; ${mismatches.length} mismatches NOT auto-resynced`,
    );
  } else if (mismatches.length > 0) {
    let firstAttempt = true;
    for (const m of mismatches) {
      // Cooldown через Redis NX. Ключ привязан к lichess_round_id —
      // переживает рестарт сервиса, не сбрасывается между tick'ами.
      const cooldownKey = `${AUTO_RESYNC_KEY_PREFIX}${m.lichessRoundId}`;
      const acquired = await deps.redis
        .set(cooldownKey, String(Date.now()), 'EX', autoResyncCooldown, 'NX')
        .catch(() => null);
      if (acquired !== 'OK') {
        stats.skippedByCooldown++;
        deps.logger.log(
          `[auto-resync] roundId=${m.lichessRoundId} status=skipped-cooldown`,
        );
        continue;
      }
      newAlerts.push(m);
      stats.attempted++;

      // Rate-limit gap между resync'ами (force-resync дёргает Lichess
      // PGN). Между mismatch'ами в одном tick'е держим 1.5с — sleepFn
      // тот же, что для PGN-counter'ов выше.
      if (!firstAttempt) await sleepFn(LICHESS_RATE_LIMIT_DELAY_MS);
      firstAttempt = false;

      // KS-3265: эскалирующий cooldown — общая логика для всех failure-
      // веток (fetched=false / persistent / exception). Шаги:
      //   1. INCR failures-counter (его текущее значение = «номер неудачи в серии»).
      //   2. Выбрать TTL из ladder по этому номеру (overflow → последний).
      //   3. EXPIRE failures-counter тем же TTL → счётчик исчезнет вместе
      //      с cooldown'ом, серия начнётся с 1 заново.
      //   4. Cooldown-ключ уже был выставлен через NX выше (cooldownKey);
      //      обновим его TTL через EXPIRE на новый, эскалированный.
      //   5. Если failures===1 — отправляем telegram. Иначе silenced.
      // На success — DEL обоих ключей (счётчик и cooldown), серия закрыта.
      const failuresKey = `${FAILURES_KEY_PREFIX}${m.lichessRoundId}`;

      const onFailure = async (
        kind: AutoResyncFailure['kind'],
        reason: string,
        gamesBefore?: number,
        gamesAfter?: number,
      ): Promise<void> => {
        const failuresCount = await deps.redis
          .incr(failuresKey)
          .catch(() => 1);
        // Wraparound на overflow ladder'а — берём последнее значение.
        const idx = Math.min(failuresCount - 1, ladder.length - 1);
        const newTtl = ladder[Math.max(0, idx)];
        await deps.redis.expire(failuresKey, newTtl).catch(() => {});
        await deps.redis.expire(cooldownKey, newTtl).catch(() => {});

        if (failuresCount === 1) {
          // Первая неудача в серии — telegram + counted в stats.
          stats.errors++; // для совместимости со счётчиком общих ошибок
          failures.push({
            mismatch: m,
            kind,
            reason,
            gamesBefore,
            gamesAfter,
          });
          deps.logger.warn(
            `[auto-resync] roundId=${m.lichessRoundId} status=${kind === 'persistent' ? 'persistent-mismatch' : kind === 'error' ? 'fetch-failed' : kind} ` +
              `failures=1 cooldown=${newTtl}s ${reason}`,
          );
        } else {
          // Повтор в серии — silenced, без telegram.
          stats.silencedByRetryLimit++;
          deps.logger.log(
            `[auto-resync] roundId=${m.lichessRoundId} status=persistent_silenced ` +
              `failures=${failuresCount} cooldown=${newTtl}s ${reason}`,
          );
        }
      };

      try {
        const r = await autoResyncFn(m.lichessRoundId);
        if (!r.fetched) {
          await onFailure(
            'error',
            'force-resync fetched=false (Lichess недоступен или PGN пуст)',
            r.gamesBefore,
            r.gamesAfter,
          );
          continue;
        }
        if (r.gamesAfter < m.lichessCount) {
          stats.persistentMismatches++;
          await onFailure(
            'persistent',
            `после resync gamesAfter=${r.gamesAfter} < lichessCount=${m.lichessCount}`,
            r.gamesBefore,
            r.gamesAfter,
          );
          continue;
        }
        // Успех. KS-3265 extension: вместо DEL failuresKey'я даём ему
        // grace-окно (`successGraceSec`, default 600s). Если в течение
        // grace'а тот же rid снова сбойнёт — INCR даст counter ≥ 2 и
        // отработает silenced-веткой (flap «success → fail» не шумит
        // в telegram). По истечении grace'а ключ испаряется естественно
        // и серия закрывается.
        //
        // Cooldown DEL'им сразу — после успеха надо разрешить мгновенный
        // retry, если Lichess дотечёт ещё партий через минуту.
        await deps.redis
          .expire(failuresKey, successGraceSec)
          .catch(() => {});
        await deps.redis.del(cooldownKey).catch(() => {});
        stats.succeeded++;
        deps.logger.log(
          `[auto-resync] roundId=${m.lichessRoundId} status=ok before=${r.gamesBefore} after=${r.gamesAfter} grace=${successGraceSec}s`,
        );
      } catch (err) {
        await onFailure('error', `exception: ${(err as Error).message}`);
      }
    }
  }

  // Telegram только на failures (errors + persistent). Успешные
  // auto-resync'и тихие — пользователь видит результат в БД.
  let telegramSent = false;
  if (failures.length > 0) {
    const text = formatAutoResyncFailureMessage(failures);
    telegramSent = await telegramFn(text).catch(() => false);
    if (!telegramSent) {
      deps.logger.warn(
        `[broadcast-metric] telegram send failed for ${failures.length} auto-resync failure(s)`,
      );
    } else {
      deps.logger.log(
        `[broadcast-metric] telegram alert sent for ${failures.length} auto-resync failure(s)`,
      );
    }
  }

  return {
    scannedBroadcasts,
    scannedRounds: rows.length,
    mismatches,
    newAlerts,
    telegramSent,
    autoResyncStats: stats,
  };
}

/**
 * Запрашивает Lichess PGN раунда и считает количество партий. Подсчёт
 * по `[White ` headers — у каждой партии ровно один такой. Возвращает
 * null если Lichess недоступен — игнорируем mismatch, скипаем тик.
 *
 * Не парсим полностью через `parsePgnGames` чтобы избежать chess.js на
 * больших турнирах (Steinitz Open: 50+ партий с полными ходами) — нам
 * нужен только count.
 */
async function fetchLichessRoundGameCount(
  lichessRoundId: string,
  fetchFn: typeof fetch,
  logger: MetricCheckLogger,
): Promise<number | null> {
  const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Kingside/1.0 (https://kingside.app)',
        Accept: 'application/x-chess-pgn',
      },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 = раунд удалён/архивирован — count=0 формально, но не
      // мерим как mismatch (наш count тоже 0 либо мы хранили запись).
      if (res.status === 404) return 0;
      logger.warn(
        `[broadcast-metric] lichess HTTP ${res.status} on round ${lichessRoundId}`,
      );
      return null;
    }
    const pgn = await res.text();
    if (!pgn.trim()) return 0;
    // Считаем секции по началу новой партии: [White "..."] заголовок
    // встречается ровно один раз на партию.
    const matches = pgn.match(/^\[White\s+"/gm);
    return matches ? matches.length : 0;
  } catch (err) {
    logger.warn(
      `[broadcast-metric] lichess fetch error for ${lichessRoundId}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Формирует одно агрегированное telegram-сообщение по всем новым
 * mismatch'ам. Markdown-форматирование совместимо с tg parse_mode.
 */
export function formatTelegramMessage(alerts: RoundMismatch[]): string {
  const lines: string[] = [
    `⚠️ *Broadcast import mismatch* (${alerts.length})`,
    '',
  ];
  // Группируем по broadcast'у — обычно одна регрессия = все раунды одного.
  const byBroadcast = new Map<string, RoundMismatch[]>();
  for (const a of alerts) {
    const k = a.broadcastId;
    if (!byBroadcast.has(k)) byBroadcast.set(k, []);
    byBroadcast.get(k)!.push(a);
  }
  for (const group of byBroadcast.values()) {
    const first = group[0];
    lines.push(`📺 *${escapeMd(first.broadcastTitle)}*`);
    lines.push(`   lichess: \`${first.lichessBroadcastId}\``);
    for (const a of group) {
      lines.push(
        `   • ${escapeMd(a.roundName)}: у нас *${a.ourCount}*, на lichess *${a.lichessCount}*`,
      );
    }
    lines.push('');
  }
  lines.push('_Подробности — в логах broadcast-service (поиск по `MISMATCH`)._');
  return lines.join('\n');
}

function escapeMd(s: string): string {
  // Минимальный escape для tg Markdown (v1): _ * ` [.
  return s.replace(/([_*`\[\]])/g, '\\$1');
}

/**
 * KS-3264. Telegram-сообщение об ошибках авто-resync. Шлётся ТОЛЬКО
 * когда automated recovery не справился (Lichess недоступен, persistent
 * mismatch после resync, exception). Успешный auto-resync — тихий,
 * никаких уведомлений.
 */
export function formatAutoResyncFailureMessage(
  failures: AutoResyncFailure[],
): string {
  const errors = failures.filter((f) => f.kind === 'error');
  const persistent = failures.filter((f) => f.kind === 'persistent');
  const lines: string[] = [
    `⚠️ *Auto-resync failures* (${failures.length})`,
    '',
  ];
  if (errors.length > 0) {
    lines.push(`❌ *Errors* (${errors.length}) — Lichess/exception:`);
    for (const f of errors) {
      lines.push(
        `   • ${escapeMd(f.mismatch.broadcastTitle)} / ${escapeMd(f.mismatch.roundName)} ` +
          `(lichess=\`${f.mismatch.lichessBroadcastId}\`/\`${f.mismatch.lichessRoundId}\`) — ${escapeMd(f.reason)}`,
      );
    }
    lines.push('');
  }
  if (persistent.length > 0) {
    lines.push(
      `🔁 *Persistent mismatch after resync* (${persistent.length}):`,
    );
    for (const f of persistent) {
      lines.push(
        `   • ${escapeMd(f.mismatch.broadcastTitle)} / ${escapeMd(f.mismatch.roundName)}: ` +
          `${f.gamesBefore ?? '?'} → *${f.gamesAfter ?? '?'}*, lichess=*${f.mismatch.lichessCount}*`,
      );
    }
    lines.push('');
  }
  lines.push(
    '_На каждый раунд держится 1-часовой cooldown. Если ошибка системная — нужен ручной разбор; если transient (Lichess 429) — на следующем tick auto-resync попробует снова._',
  );
  return lines.join('\n');
}

/**
 * Дефолтная telegram-отправка через Bot API. Возвращает false если env
 * не сконфигурирован или API упал. Не throw'ит — cron должен идти дальше.
 */
async function defaultTelegramSend(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    process.env.BROADCAST_ALERT_TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * NestJS-обёртка с cron'ом. Тонкий слой над `runGameCountCheckTick`.
 */
@Injectable()
export class BroadcastGameCountMetricService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BroadcastGameCountMetricService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    // KS-3264: для auto-resync вместо telegram-алерта на mismatch.
    private readonly syncService: BroadcastSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.BROADCAST_GAME_COUNT_CHECK_ENABLED !== 'true') {
      this.logger.log(
        'BROADCAST_GAME_COUNT_CHECK_ENABLED != "true" — metric check disabled',
      );
      return;
    }
    const tickMs = parseEnvInt(
      'BROADCAST_GAME_COUNT_CHECK_TICK_MS',
      DEFAULT_TICK_INTERVAL_MS,
    );
    this.logger.log(
      `[broadcast-metric] starting, tickIntervalMs=${tickMs}, ` +
        `alertTtlSec=${parseEnvInt('BROADCAST_GAME_COUNT_ALERT_TTL_SEC', DEFAULT_ALERT_TTL_SEC)}, ` +
        `telegram=${process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'DISABLED (no TELEGRAM_BOT_TOKEN)'}`,
    );
    // Первый tick через 60с — даём sync подняться, не конкурируем за
    // Lichess quota в первые секунды.
    setTimeout(() => void this.tickSafe(), 60_000).unref();
    this.timer = setInterval(() => void this.tickSafe(), tickMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tickSafe(): Promise<void> {
    if (this.stopped) return;
    if (!(await this.acquireLock())) {
      this.logger.log(
        '[broadcast-metric] tick skipped (lock held by other replica)',
      );
      return;
    }
    const start = Date.now();
    try {
      const r = await runGameCountCheckTick({
        prisma: this.prisma as unknown as MetricCheckPrisma,
        redis: this.redis as unknown as MetricCheckRedis,
        logger: {
          log: (m) => this.logger.log(m),
          warn: (m) => this.logger.warn(m),
          error: (m) => this.logger.error(m),
        },
        telegramFn: defaultTelegramSend,
        // KS-3264: auto-resync через прямой вызов сервиса (внутри одного
        // процесса). HTTP к самому себе не нужен.
        autoResyncFn: (lichessRoundId) =>
          this.syncService.forceResyncRound(lichessRoundId),
        alertTtlSec: parseEnvInt(
          'BROADCAST_GAME_COUNT_ALERT_TTL_SEC',
          DEFAULT_ALERT_TTL_SEC,
        ),
        autoResyncCooldownSec: parseEnvInt(
          'BROADCAST_GAME_COUNT_AUTO_RESYNC_COOLDOWN_SEC',
          DEFAULT_AUTO_RESYNC_COOLDOWN_SEC,
        ),
        // KS-3265: эскалирующий cooldown через CSV `1ч,3ч,12ч,24ч` (sec).
        failureCooldownLadderSec: parseEnvCsvInt(
          'BROADCAST_GAME_COUNT_FAILURE_COOLDOWN_LADDER_SEC',
          DEFAULT_FAILURE_COOLDOWN_LADDER_SEC,
        ),
        // KS-3265 (extension): grace-окно после success'а — failures-
        // counter живёт ещё `successGraceSec` секунд вместо мгновенного
        // DEL. Подавляет flap «success → fail в течение grace».
        successGraceSec: parseEnvInt(
          'BROADCAST_AUTO_RESYNC_SUCCESS_GRACE_SEC',
          DEFAULT_AUTO_RESYNC_SUCCESS_GRACE_SEC,
        ),
        maxBroadcasts: parseEnvInt(
          'BROADCAST_GAME_COUNT_MAX_BROADCASTS',
          DEFAULT_MAX_BROADCASTS,
        ),
      });
      const ar = r.autoResyncStats;
      this.logger.log(
        `[broadcast-metric] tick scanned=${r.scannedRounds} rounds in ` +
          `${r.scannedBroadcasts} broadcasts; mismatches=${r.mismatches.length} ` +
          `autoResync attempted=${ar.attempted} succeeded=${ar.succeeded} ` +
          `persistent=${ar.persistentMismatches} errors=${ar.errors} ` +
          `silencedByRetryLimit=${ar.silencedByRetryLimit} ` +
          `skippedByCooldown=${ar.skippedByCooldown} ` +
          `telegramSent=${r.telegramSent} durationMs=${Date.now() - start}`,
      );
    } catch (err) {
      this.logger.error(
        `[broadcast-metric] tick failed: ${(err as Error).message}`,
      );
    }
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

/**
 * KS-3265. Парсит CSV из env в массив положительных целых.
 * Невалидные значения / пустая env → fallback на default.
 */
function parseEnvCsvInt(name: string, def: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return def;
  const parts = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : def;
}
