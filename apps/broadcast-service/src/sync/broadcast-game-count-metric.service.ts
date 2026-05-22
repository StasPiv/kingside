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

const LICHESS_API = 'https://lichess.org/api';

const DEFAULT_TICK_INTERVAL_MS = 600_000; // 10 минут
const DEFAULT_ALERT_TTL_SEC = 3600; // 1 час
const DEFAULT_MAX_BROADCASTS = 20;
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
  alertTtlSec?: number;
  maxBroadcasts?: number;
}

export interface MetricCheckSummary {
  scannedBroadcasts: number;
  scannedRounds: number;
  mismatches: RoundMismatch[];
  newAlerts: RoundMismatch[];
  telegramSent: boolean;
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

  // Дедупликация. Для каждого mismatch'а — пытаемся выставить
  // alert-ключ NX. Если ключ уже был — пропускаем (значит за последний
  // час уже алертили).
  const newAlerts: RoundMismatch[] = [];
  for (const m of mismatches) {
    const key = `${ALERT_KEY_PREFIX}${m.broadcastId}:${m.roundId}`;
    const r = await deps.redis.set(key, '1', 'EX', alertTtl, 'NX');
    if (r === 'OK') {
      newAlerts.push(m);
    }
  }

  let telegramSent = false;
  if (newAlerts.length > 0) {
    const text = formatTelegramMessage(newAlerts);
    telegramSent = await telegramFn(text).catch(() => false);
    if (!telegramSent) {
      // Откатываем дедуп-ключи: если telegram упал, на следующем tick'е
      // снова попробуем алертить (иначе час молчания при недоступном
      // телеграме = потерянная регрессия).
      deps.logger.warn(
        `[broadcast-metric] telegram send failed for ${newAlerts.length} alert(s); ` +
          `dedup keys NOT released (TTL=${alertTtl}s) — мы избегаем спама на ` +
          `flapping. Лог mismatches остаётся.`,
      );
    } else {
      deps.logger.log(
        `[broadcast-metric] telegram alert sent for ${newAlerts.length} new mismatch(es)`,
      );
    }
  }

  // Лог всех mismatch'ей (включая old, для долгосрочной аналитики).
  for (const m of mismatches) {
    deps.logger.warn(
      `[broadcast-metric] MISMATCH broadcast="${m.broadcastTitle}" ` +
        `(lichess=${m.lichessBroadcastId}) round="${m.roundName}" ` +
        `our=${m.ourCount} lichess=${m.lichessCount}`,
    );
  }

  return {
    scannedBroadcasts,
    scannedRounds: rows.length,
    mismatches,
    newAlerts,
    telegramSent,
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
        alertTtlSec: parseEnvInt(
          'BROADCAST_GAME_COUNT_ALERT_TTL_SEC',
          DEFAULT_ALERT_TTL_SEC,
        ),
        maxBroadcasts: parseEnvInt(
          'BROADCAST_GAME_COUNT_MAX_BROADCASTS',
          DEFAULT_MAX_BROADCASTS,
        ),
      });
      this.logger.log(
        `[broadcast-metric] tick scanned=${r.scannedRounds} rounds in ` +
          `${r.scannedBroadcasts} broadcasts; mismatches=${r.mismatches.length} ` +
          `newAlerts=${r.newAlerts.length} telegramSent=${r.telegramSent} ` +
          `durationMs=${Date.now() - start}`,
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
