import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
// KS-4205: postановка prerender при transition'ах раунда.
import { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';
import { createHash } from 'crypto';
import { Chess } from 'chess.js';
import Redis from 'ioredis';
// KS-4842. Собственный undici Agent для стримов: изолирует пул от
// общего dispatcher'а (KS-4841) и включает TCP keep-alive, которого
// нет в дефолтном Node fetch. TCP-зонды дают быстрый сигнал о разрыве,
// если Lichess закрыл соединение молча.
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
import {
  parsePgnGames as parsePgnGamesPure,
  findDuplicateGameIds,
  type ParsedGame as ParsedGamePure,
} from './pgn-parser';

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
// KS-4859 / ADR-159 §2.3, §2.7, §3.1 п.3. Учащённый PGN-опрос для
// раундов ongoing с subs >= 1 (и pending с subs >= 1 в окне
// [NOW, NOW+15 мин], см. ADR-158 §2.6). После удаления runStream() это
// единственный канал получения свежих ходов с Lichess на backend.
const FAST_POLL_INTERVAL_MS = parseInt(
  process.env.BROADCAST_FAST_POLL_INTERVAL_MS ?? '30000',
  10,
);
// KS-4859 / ADR-159 §3.1 п.3: 20 → 25 (без стримов backend обслуживает
// все popular раунды опросом, потолок разумно поднять).
const MAX_FAST_POLLS_PER_TICK = parseInt(
  process.env.BROADCAST_MAX_FAST_POLLS ?? '25',
  10,
);
const FAST_POLL_LOCK_KEY = 'broadcast:fast-poll:lock';
const FAST_POLL_LOCK_TTL_SEC = 25;
const FAST_POLL_COOLDOWN_TTL_SEC = 25;
const FAST_POLL_COOLDOWN_KEY_PREFIX = 'broadcast:fast-poll-cooldown:';
// KS-4846 / ADR-157 §2.3. Redis-хеш активных WS-подписок per round.
// KS-4859: роль пересмотрена (ADR-159 §2.7) — теперь это не приоритет
// для 8 стримов, а критерий fast poll vs slow poll (subs >= 1 → fast).
const WS_SUBS_HASH_KEY = 'broadcast:ws-subs';
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_COOLDOWN_TTL = 60 * 60;
const SYNC_LOCK_KEY = 'broadcast:sync:lock';
// KS-4832 / ADR-156 §2.2. Было 4 мин — цикл `syncBroadcasts` не влезал в
// лок (~31 мин от старой полной прокрутки `refreshNonTop20`), лок истекал
// и следующий тик стартовал параллельно → накопление 10 циклов, undici
// pool exhaustion, ETIMEDOUT. С квотой §2.1 типовой цикл ≈4.5 мин, лок
// 10 мин даёт запас 2.2×. Крах процесса — ждать 10 мин до перезахвата.
const SYNC_LOCK_TTL = 10 * 60;
const PINNED_LOCK_KEY = 'broadcast:pinned:lock';
const PINNED_LOCK_TTL = 50;
const PGN_HASH_TTL = 300;
const RATE_LIMIT_DELAY_MS = 1500;
// KS-3334 (replaces KS-1219). Per-endpoint backoff: глобальный 60-сек
// блокировал все Lichess-запросы, когда у нас persistent 429 на ОДНОМ
// round-PGN endpoint'е. Теперь backoff трекается отдельно по ключу
// (URL hostname + path), failures-счётчик растёт, TTL экспоненциально
// эскалирует. Таким образом 429 на одном round'е не блокирует tour-API
// и другие round-endpoint'ы.
const RATE_LIMIT_429_BACKOFF_BASE_TTL_SEC = 60;
const RATE_LIMIT_429_BACKOFF_LADDER_SEC = [60, 180, 600, 1800]; // 1м/3м/10м/30м
const RATE_LIMIT_429_BACKOFF_MAX_TTL_SEC = 1800;
const RATE_LIMIT_429_JITTER_PCT = 0.3; // ±30% jitter чтобы не синхронизировать retry'и реплик
// KS-4832 / ADR-156 §2.1. Квота на `refreshNonTop20RoundStatuses` за один
// цикл `syncBroadcasts`. При 1234 non-top-20 раундах × 1.5 сек rate-limit
// один прогон занимал ~31 мин, лок 4 мин истекал, циклы накладывались.
// Default 50 → ~75 сек на фазу, 25 циклов на полный обход = ~2 часа.
// Redis-cursor держит offset между циклами.
const MAX_ROUND_METADATA_CHECKS_PER_CYCLE = parseInt(
  process.env.BROADCAST_MAX_ROUND_METADATA_CHECKS ?? '50',
  10,
);
const REFRESH_CURSOR_KEY = 'broadcast:refresh:cursor';
const REFRESH_CURSOR_TTL = 60 * 60;
// KS-4832 / ADR-155 §2.4. Pending-heal — вторая фаза pinned-цикла.
// Проверяет metadata раундов, застрявших в `pending`, чтобы переводить
// их в `ongoing` без зависимости от главного full-sync (который может
// систематически валиться, см. KS-4832). Только metadata, PGN — нет.
const PENDING_HEAL_ENABLED = process.env.BROADCAST_PENDING_HEAL_ENABLED !== 'false';
const MAX_PENDING_CHECKS_PER_CYCLE = parseInt(
  process.env.BROADCAST_MAX_PENDING_CHECKS ?? '10',
  10,
);
// ADR-155 §2.4.4. Cooldown между двумя проверками одного и того же
// roundId в pending-heal. Один цикл = 60 сек. При малом числе pending
// без cooldown round-robin молотит одни и те же 2-3 раунда каждые 60 сек.
const PENDING_CHECK_COOLDOWN_TTL = 60;
const PENDING_CHECK_COOLDOWN_KEY_PREFIX = 'broadcast:pending-check-cooldown:';
// ADR-155 §2.4.2. Окно для отбора pending-кандидатов: раунд должен уже
// «созреть» (startsAt в прошлом или в ближайшие 15 мин) и не быть
// зомби (не старше 24 ч). Значения — в миллисекундах.
const PENDING_WINDOW_UPPER_MS = 15 * 60 * 1000;
const PENDING_WINDOW_LOWER_MS = 24 * 60 * 60 * 1000;
const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// KS-4846 / ADR-157 §2.4.1. Метки для counter
// `broadcast_lichess_requests_total`. Строго ограничены — расширять только
// вместе с sync-metrics.ts.
type LichessEndpointLabel =
  | 'broadcasts_list'
  | 'round_metadata'
  | 'round_pgn'
  | 'round_stream_open'
  | 'pending_metadata';
type LichessStatusLabel =
  | '200'
  | '400'
  | '401'
  | '404'
  | '429'
  | '5xx'
  | 'timeout'
  | 'abort'
  | 'err';

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
  /**
   * KS-4847 / ADR-158 §2.1. Массив пар, если Lichess их создал до старта
   * раунда. Может отсутствовать (если TDs не завели сетку заранее) или
   * приходить пустым.
   */
  games?: LichessRoundGame[];
}

/**
 * KS-4847 / ADR-158 §2.1. Одна пара в metadata-ответе Lichess
 * `/api/broadcast/-/-/{roundId}` или в общем listing.
 */
interface LichessRoundGame {
  id?: string;
  name?: string;
  fen?: string;
  players?: LichessRoundGamePlayer[];
  status?: string;
}

interface LichessRoundGamePlayer {
  name?: string;
  title?: string;
  rating?: number;
  fed?: string;
}

// KS-3230: ParsedGame теперь экспортируется из ./pgn-parser.
// Здесь оставлен alias, чтобы не править остальной код.
type ParsedGame = ParsedGamePure;

/**
 * KS-2699 / KS-2720 / KS-4855. Извлечение оставшегося времени игроков
 * из PGN-комментариев. Реализация переехала в `@kingside/shared`
 * (см. `packages/shared/src/broadcast-pgn/pgn-parser.ts`) в рамках
 * KS-4855 / ADR-159 §7 п.1. Локальный export — только для обратной
 * совместимости существующих unit-тестов (`broadcast-sync.service.spec.ts`).
 */
export { extractClocksFromPgn } from '@kingside/shared';

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
/**
 * KS-3334: ключ для per-endpoint backoff'а. Hostname + pathname без
 * query (rate-limit Lichess'а обычно per-path). Для round-PGN URL
 * (`/api/broadcast/round/<id>.pgn`) даёт уникальный backoff на каждый
 * roundId — один проблемный round не блокирует tour-API и другие.
 */
export function fetchKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * KS-3334: TTL backoff'а после очередного 429. Эскалирует по лестнице
 * `RATE_LIMIT_429_BACKOFF_LADDER_SEC` (1м/3м/10м/30м). Plus ±30% jitter
 * чтобы реплики не синхронизировались на retry'ях.
 */
export function computeBackoffTtlSec(failures: number): number {
  const idx = Math.min(
    failures - 1,
    RATE_LIMIT_429_BACKOFF_LADDER_SEC.length - 1,
  );
  const base = RATE_LIMIT_429_BACKOFF_LADDER_SEC[Math.max(0, idx)];
  const jitter = (Math.random() * 2 - 1) * RATE_LIMIT_429_JITTER_PCT;
  return Math.max(
    RATE_LIMIT_429_BACKOFF_BASE_TTL_SEC,
    Math.min(
      RATE_LIMIT_429_BACKOFF_MAX_TTL_SEC,
      Math.round(base * (1 + jitter)),
    ),
  );
}

export function isStandardVariant(variant: string | null): boolean {
  if (variant === null) return true;
  const v = variant.trim().toLowerCase();
  return v === '' || v === 'standard' || v === 'chess' || v === 'classical';
}

/**
 * KS-4836. Форматирование сетевой ошибки для лога — с раскрытием цепочки
 * `err.cause` (undici/node:fetch кладут первичную причину сюда) и
 * ключевых полей (`code`, `errno`, `syscall`, `hostname`, `address`, `port`).
 *
 * Node's `fetch` (undici) бросает `TypeError: fetch failed`, а реальная
 * причина лежит в `.cause` — обычно это `Error` с `code=UND_ERR_*`,
 * либо системная ошибка `code=EAI_AGAIN|ECONNRESET|ENOTFOUND|ETIMEDOUT`.
 * Иногда причина — `AggregateError` (например, IPv4+IPv6 одновременно), тогда
 * реальная первая ошибка в `.errors[0]`. Разворачиваем до 5 уровней глубины,
 * чтобы не зациклиться на самоссылке.
 *
 * Формат:
 *   `TypeError("fetch failed") → cause: Error("getaddrinfo EAI_AGAIN lichess.org")[code=EAI_AGAIN,errno=-3001,syscall=getaddrinfo,hostname=lichess.org]`
 */
export function formatFetchError(err: unknown): string {
  if (!err) return 'unknown';
  if (typeof err !== 'object') return String(err);

  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  const seen = new Set<unknown>();

  while (current && depth < 5 && !seen.has(current)) {
    seen.add(current);
    const e = current as Error & {
      cause?: unknown;
      code?: string | number;
      errno?: number | string;
      syscall?: string;
      hostname?: string;
      address?: string;
      port?: number;
      errors?: unknown[];
    };
    const cls =
      (e.constructor && e.constructor.name) ||
      (e as { name?: string }).name ||
      'Error';
    const msg =
      typeof e.message === 'string' && e.message.length > 0
        ? e.message
        : String(e);
    const tail: string[] = [];
    if (e.code !== undefined) tail.push(`code=${String(e.code)}`);
    if (e.errno !== undefined) tail.push(`errno=${String(e.errno)}`);
    if (e.syscall) tail.push(`syscall=${e.syscall}`);
    if (e.hostname) tail.push(`hostname=${e.hostname}`);
    if (e.address) tail.push(`address=${e.address}`);
    if (e.port !== undefined) tail.push(`port=${String(e.port)}`);
    parts.push(
      `${cls}("${msg}")${tail.length ? '[' + tail.join(',') + ']' : ''}`,
    );

    // AggregateError или undici errors[] — первый элемент считается первичной причиной.
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      current = e.errors[0];
    } else {
      current = e.cause;
    }
    depth++;
  }
  return parts.join(' → cause: ');
}

@Injectable()
export class BroadcastSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastSyncService.name);

  private pubRedis: Redis | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private pinnedPollTimer: NodeJS.Timeout | null = null;
  // KS-4859 / ADR-159 §2.3. Единый тик учащённого PGN-опроса (30 сек)
  // — основной канал обновления БД после удаления runStream().
  private fastPollTimer: NodeJS.Timeout | null = null;
  // KS-4846 / ADR-157 §2.4.2. Список раундов, для которых мы уже выставили
  // gauge — нужен, чтобы при уходе раунда из active-выборки убрать метку
  // (иначе gauge живёт как «замороженный» с прошлым значением).
  private readonly wsSubsGaugeRounds = new Set<string>();
  private pollOffset = 0;
  // KS-4832 / ADR-155 §2.4.3. Round-robin индекс отдельно от `pollOffset`,
  // чтобы pending-фаза не влияла на распределение PGN-опросов.
  private pendingOffset = 0;
  // KS-3334: per-endpoint backoff (replaces глобальный rateLimitBackoffUntil
  // из KS-1219). Ключ — fetchKey(url) (hostname + pathname без query).
  private readonly endpointBackoffUntil = new Map<string, number>();
  private readonly endpointBackoffFails = new Map<string, number>();
  private stopped = false;
  private started = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: SyncMetricsService,
    // KS-2723: для event-driven инвалидации кэша standings при
    // изменении result или появлении новой partii.
    private readonly standingsSync: BroadcastStandingsSyncService,
    /**
     * KS-4205 / ADR-128 §10 #11 §7.3.7. Постановка prerender при
     * переходе раундов в `ongoing`/`finished`. Глобальный провайдер
     * (PrerenderModule), в тестах — мок.
     */
    private readonly prerender: PrerenderEnqueueService,
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
      // KS-4845. Тело не читаем, значит undici держит соединение
      // waiting-for-body. Дренируем, чтобы вернуть сокет в keep-alive
      // pool.
      await testRes.body?.cancel().catch(() => {});
    } catch (e: unknown) {
      // KS-4836. Раскрываем цепочку err.cause до системного code/syscall.
      this.logger.error(
        `[broadcast-sync] Lichess API UNREACHABLE: ${formatFetchError(e)}`,
      );
    }

    // KS-3229: one-shot cleanup сломанных записей. До фикса parsePgnGames
    // некорректно брал lichess_game_id из [Site "..."] — для broadcast'ов,
    // где Site содержит физический адрес (например "Bucharest, Romania",
    // GCT Romania 2026), это давало один и тот же lichessGameId для всех
    // 5 партий раунда, и upsert по (roundId, lichessGameId) перезаписывал
    // одну запись 5 раз. В БД оставалась 1 партия из 5.
    //
    // Признак broken-записи: lichess_game_id содержит запятую, пробел или
    // не похож на base62. Реальный lichess id — 8 символов [A-Za-z0-9].
    // Удаляем такие записи; следующий sync пересоздаст их корректно с
    // настоящими id из [GameURL "..."].
    //
    // Идемпотентно: после первого прогона строк не остаётся, повторный
    // запуск даёт 0 deleted и просто логируется.
    try {
      const broken = await this.prisma.$executeRawUnsafe(
        `DELETE FROM broadcast_games
         WHERE lichess_game_id IS NOT NULL
           AND (lichess_game_id ~ '[^A-Za-z0-9]'
                AND lichess_game_id NOT LIKE 'round:%')`,
      );
      if (broken > 0) {
        this.logger.warn(
          `[broadcast-sync] KS-3229 cleanup: deleted ${broken} broken games (non-base62 lichess_game_id, e.g. "Bucharest, Romania")`,
        );
      } else {
        this.logger.log(
          '[broadcast-sync] KS-3229 cleanup: 0 broken games (already clean)',
        );
      }
    } catch (e: unknown) {
      this.logger.error(
        `[broadcast-sync] KS-3229 cleanup failed: ${(e as Error).message}`,
      );
    }

    // KS-2450 (deploy-fix): инициальный sync — fire-and-forget. До этого
    // блокировал OnModuleInit на ~4 минуты (100 broadcasts), из-за чего
    // app.listen() не успевал открыть порт 3004 раньше ALB health-check
    // unhealthy threshold (45s). ECS убивал таск как deadlock, деплой
    // зацикливался на rollback. Стартовый sync теперь идёт в фоне после
    // того как процесс уже слушает порт; periodic sync — как и раньше.
    setImmediate(() => {
      this.syncBroadcasts().catch((e: unknown) =>
        this.logger.error(
          `[broadcast-sync] Initial sync error: ${formatFetchError(e)}`,
        ),
      );
    });
    this.syncTimer = setInterval(() => {
      this.syncBroadcasts().catch((e: unknown) =>
        this.logger.error(
          `[broadcast-sync] Sync error: ${formatFetchError(e)}`,
        ),
      );
    }, SYNC_INTERVAL_MS);

    setImmediate(() => {
      this.syncPinnedBroadcasts().catch((e: unknown) =>
        this.logger.error(
          `[broadcast-sync] Initial pinned poll error: ${formatFetchError(e)}`,
        ),
      );
    });
    this.pinnedPollTimer = setInterval(() => {
      this.syncPinnedBroadcasts().catch((e: unknown) =>
        this.logger.error(
          `[broadcast-sync] PGN poll error: ${formatFetchError(e)}`,
        ),
      );
    }, PINNED_POLL_INTERVAL_MS);

    // KS-4859 / ADR-159 §2.3. Учащённый PGN-опрос стал основным каналом
    // обновления БД (SSE-стримы к Lichess теперь читает клиент напрямую).
    // Первый запуск отложен на 5 сек — startup даёт время для warm-up
    // Redis/gateway и первых WS-подписок.
    setTimeout(() => {
      this.runFastPollTick().catch((e: unknown) =>
        this.logger.error(
          `[broadcast-sync] Initial fast-poll tick failed: ${formatFetchError(e)}`,
        ),
      );
    }, 5000);
    this.fastPollTimer = setInterval(() => {
      this.runFastPollTick().catch((e: unknown) =>
        this.logger.error(
          `[broadcast-sync] Fast-poll tick failed: ${formatFetchError(e)}`,
        ),
      );
    }, FAST_POLL_INTERVAL_MS);

    this.logger.log(
      '[broadcast-sync] Running (initial syncs scheduled in background)',
    );
  }

  /**
   * KS-4846 / ADR-157 §2.3. Прочитать Redis-хеш `broadcast:ws-subs`
   * в Map<roundId, count>. Записи с count <= 0 отбрасываются (защита от
   * дрейфа — уборка их отдельным периодическим тиком в gateway).
   */
  private async readWsSubs(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const raw = await this.redis.hgetall(WS_SUBS_HASH_KEY);
      for (const [roundId, value] of Object.entries(raw)) {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) out.set(roundId, n);
      }
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] readWsSubs failed: ${(e as Error).message}`,
      );
    }
    return out;
  }

  /**
   * KS-4846 / ADR-157 §2.7 + KS-4847 / ADR-158 §2.6 + KS-4859 / ADR-159
   * §2.3. Тик учащённого опроса — основной канал обновления БД для
   * раундов, за которыми зрители следят в реальном времени. После
   * удаления `runStream()` (ADR-159 §2.3) backend больше не открывает
   * SSE-стримы к Lichess — вся живая свежесть идёт из этого тика.
   *
   *  - `ongoing` с `subs >= 1` → PGN-опрос (`fetchAndProcessRoundPgn`).
   *  - `pending` с `subs >= 1` и `startsAt <= NOW + 15 мин` — metadata-опрос
   *    (`refreshOneRoundMetadata`, endpoint `pending_metadata`): обновит
   *    пары и подхватит промоушен в ongoing.
   *  - Redis-lock TTL 25 сек, сортировка `subs DESC, updatedAt ASC`,
   *    cap `MAX_FAST_POLLS_PER_TICK` (после ADR-159 §3.1 п.3 поднят
   *    с 20 до 25), cooldown 25 сек per roundId, общий
   *    `rateLimitDelay(1500 ms)` между вызовами.
   *
   * Также в начале тика публикуем gauge `broadcast_ws_active_subscriptions`
   * (раньше это делал `evaluateStreamPriorities` — метод удалён вместе с
   * приоритизацией стримов).
   */
  async runFastPollTick(): Promise<void> {
    if (!(await this.acquireLock(FAST_POLL_LOCK_KEY, FAST_POLL_LOCK_TTL_SEC))) {
      return;
    }
    try {
      const subs = await this.readWsSubs();

      // KS-4846 §2.4.2. Публикуем gauge для всех известных раундов, для
      // «ушедших» из хеша — снимаем метку.
      const seenNow = new Set<string>();
      for (const [roundId, count] of subs) {
        if (count <= 0) continue;
        this.metrics.setWsActiveSubscriptions(roundId, count);
        this.wsSubsGaugeRounds.add(roundId);
        seenNow.add(roundId);
      }
      for (const roundId of Array.from(this.wsSubsGaugeRounds)) {
        if (!seenNow.has(roundId)) {
          this.metrics.removeWsActiveSubscription(roundId);
          this.wsSubsGaugeRounds.delete(roundId);
        }
      }

      if (subs.size === 0) return;

      // KS-4847 §2.6. Окно pending — startsAt <= NOW + 15 мин (симметрично
      // pending-heal §2.4.2 ADR-155).
      const pendingUpper = new Date(Date.now() + 15 * 60 * 1000);
      const rounds = await this.prisma.broadcastRound.findMany({
        where: {
          OR: [
            { status: 'ongoing' },
            {
              status: 'pending',
              startsAt: { not: null, lte: pendingUpper },
            },
          ],
        },
        select: {
          id: true,
          lichessRoundId: true,
          status: true,
          updatedAt: true,
        },
      });
      // KS-4859 / ADR-159 §3.1 п.3. Раньше фильтр отсекал раунды в
      // `activeStreams` — теперь стримов нет, все ongoing с subs>=1 идут
      // в fast poll.
      const candidates = rounds
        .map((r) => ({
          id: r.id,
          roundId: r.lichessRoundId,
          status: r.status,
          subs: subs.get(r.lichessRoundId) ?? 0,
          updatedAt: r.updatedAt,
        }))
        .filter((r) => r.subs >= 1)
        .sort((a, b) => {
          // §2.6: сначала ongoing, потом pending; внутри — subs DESC,
          // затем updatedAt ASC (стагнирующие обновляем в первую очередь).
          if (a.status !== b.status) return a.status === 'ongoing' ? -1 : 1;
          if (b.subs !== a.subs) return b.subs - a.subs;
          return a.updatedAt.getTime() - b.updatedAt.getTime();
        })
        .slice(0, MAX_FAST_POLLS_PER_TICK);

      if (candidates.length === 0) return;

      this.logger.log(
        `[broadcast-sync] fast-poll tick: ${candidates.length} rounds (cap ${MAX_FAST_POLLS_PER_TICK})`,
      );

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const cooldownKey = `${FAST_POLL_COOLDOWN_KEY_PREFIX}${c.roundId}`;
        const cooldown = await this.redis.get(cooldownKey).catch(() => null);
        if (cooldown) continue;

        if (i > 0) await this.rateLimitDelay();
        try {
          if (c.status === 'pending') {
            // KS-4847 §2.6. Для pending — metadata-опрос: обновит status
            // (при промоушене на Lichess) и подтянет пары из body.games[].
            await this.refreshOneRoundMetadata(
              {
                id: c.id,
                lichessRoundId: c.roundId,
                status: c.status,
              },
              'pending_metadata',
            );
          } else {
            await this.fetchAndProcessRoundPgn(c.roundId);
          }
        } catch (e: unknown) {
          this.logger.warn(
            `[broadcast-sync] fast-poll ${c.roundId} (${c.status}) failed: ${formatFetchError(e)}`,
          );
        }
        await this.redis
          .set(cooldownKey, '1', 'EX', FAST_POLL_COOLDOWN_TTL_SEC)
          .catch(() => {});
      }
    } finally {
      await this.redis.del(FAST_POLL_LOCK_KEY).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.pinnedPollTimer) clearInterval(this.pinnedPollTimer);
    if (this.fastPollTimer) clearInterval(this.fastPollTimer);

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

  private fetchKey(url: string): string {
    return fetchKey(url);
  }

  private computeBackoffTtlSec(failures: number): number {
    return computeBackoffTtlSec(failures);
  }

  /**
   * KS-4846 / ADR-157 §2.4.1. Классификация URL Lichess для метрики
   * `broadcast_lichess_requests_total`. Если endpoint неизвестен —
   * возвращаем null, инкрементировать не будем (защита от кардинальности).
   * `hint` — явное указание вызывающей стороны (для случаев, когда
   * `/broadcast/-/-/<id>` может быть вызван и как round_metadata, и как
   * pending_metadata).
   */
  private classifyLichessEndpoint(
    url: string,
    hint?: LichessEndpointLabel,
  ): LichessEndpointLabel | null {
    if (hint) return hint;
    // Стрим-open идёт напрямую через fetch(), не через lichessFetch —
    // сюда попадаем только для не-стримовых запросов, но проверим на
    // всякий.
    if (url.includes('/stream/broadcast/round/')) return 'round_stream_open';
    if (/\/broadcast\/round\/[^/?]+\.pgn/.test(url)) return 'round_pgn';
    if (/\/broadcast\/-\/-\//.test(url)) return 'round_metadata';
    if (/\/broadcast(\?|$)/.test(url)) return 'broadcasts_list';
    return null;
  }

  /**
   * KS-4846 / ADR-157 §2.4.1. Классификация HTTP-статуса или ошибки для
   * метрики `broadcast_lichess_requests_total`.
   */
  private classifyLichessStatus(status: number): LichessStatusLabel {
    if (status >= 200 && status < 300) return '200';
    if (status === 400) return '400';
    if (status === 401) return '401';
    if (status === 404) return '404';
    if (status === 429) return '429';
    if (status >= 500 && status < 600) return '5xx';
    return 'err';
  }

  private classifyLichessError(err: unknown): LichessStatusLabel {
    if (err instanceof Error) {
      // AbortError c reason=TimeoutError → timeout, иначе abort.
      if (err.name === 'TimeoutError') return 'timeout';
      if (err.name === 'AbortError') {
        const cause = (err as Error & { cause?: unknown }).cause;
        if (
          cause &&
          typeof cause === 'object' &&
          (cause as { name?: string }).name === 'TimeoutError'
        ) {
          return 'timeout';
        }
        return 'abort';
      }
    }
    return 'err';
  }

  private async lichessFetch(
    url: string,
    init?: RequestInit,
    endpointHint?: LichessEndpointLabel,
  ): Promise<Response> {
    const key = this.fetchKey(url);
    const until = this.endpointBackoffUntil.get(key) ?? 0;
    if (Date.now() < until) {
      const secsLeft = Math.ceil((until - Date.now()) / 1000);
      throw new Error(`Lichess 429 backoff active for ${key} (${secsLeft}s left)`);
    }
    const endpoint = this.classifyLichessEndpoint(url, endpointHint);
    try {
      // KS-3334: опциональный bearer-токен для повышенных rate-лимитов
      // (Lichess: ~8000 req/h authenticated vs ~800 anonymous). Токен
      // через env `LICHESS_API_TOKEN`. Не задан → анонимные запросы.
      const token = process.env.LICHESS_API_TOKEN;
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> | undefined),
      };
      if (token && !headers['Authorization']) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(url, {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // KS-4846 §2.4.1. Единая точка инкремента — единственная зависимая
      // от endpoint-классификации метрика.
      if (endpoint) {
        this.metrics.recordLichessRequest(
          endpoint,
          this.classifyLichessStatus(res.status),
        );
      }
      if (res.status === 429) {
        const failures = (this.endpointBackoffFails.get(key) ?? 0) + 1;
        this.endpointBackoffFails.set(key, failures);
        const ttlSec = this.computeBackoffTtlSec(failures);
        this.endpointBackoffUntil.set(key, Date.now() + ttlSec * 1000);
        this.logger.warn(
          `[broadcast-sync] Lichess 429 on ${url}. ` +
            `Per-endpoint backoff: key=${key} failures=${failures} ttl=${ttlSec}s`,
        );
        // KS-4845. Дренаж тела до throw — иначе undici держит TCP
        // waiting-for-body, слот в keep-alive-pool не освобождается, и
        // через ~сотни утечек новые connect() висят до 30-сек таймаута
        // → массовые ETIMEDOUT (см. разбор в KS-4841).
        await res.body?.cancel().catch(() => {});
        throw new Error('Lichess 429 Too Many Requests');
      }
      // KS-3334: успех → сбрасываем failures-счётчик (но не до 0 сразу —
      // оставляем 1 на короткий grace period, чтобы flap success→fail не
      // сразу опускал лестницу обратно к 1 минуте). Хотя нам легче
      // сбросить в 0 — следующий 429 даст 1 минуту, что нормально.
      if (this.endpointBackoffFails.has(key)) {
        this.endpointBackoffFails.delete(key);
      }
      return res;
    } catch (e: unknown) {
      // KS-4846 §2.4.1. Инкремент по типу ошибки. Не путать с 429 —
      // 429 идёт через `res.status === 429`, а сюда падают сетевые сбои.
      if (endpoint) {
        this.metrics.recordLichessRequest(
          endpoint,
          this.classifyLichessError(e),
        );
      }
      // KS-4836. Раскрываем цепочку err.cause до системного code/syscall.
      this.logger.error(
        `[broadcast-sync] lichessFetch FAILED url=${url} error=${formatFetchError(e)}`,
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
          // KS-4859 / ADR-159 §2.3. Раньше здесь стартовал стрим
          // (`startStream(round.id)`) для промоушенных в ongoing раундов.
          // После удаления `runStream()` данные обновляются только через
          // fast poll (subs>=1) и slow pinned poll (subs=0).
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

      // KS-4859 / ADR-159 §2.3. Раньше здесь абортились стримы, чей
      // раунд больше не ongoing (`activeStreams` cleanup). Стримов
      // больше нет — блок удалён вместе с `runStream()`.

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

      // KS-4846 / ADR-157 §2.8 + KS-4859 / ADR-159 §3.1 п.4. Slow pinned
      // poll обслуживает раундов без зрителей — на них никто не смотрит,
      // обновлять чаще 5 мин расход квоты Lichess без пользы. Раунды с
      // subs >= 1 идут в fast poll (30 сек, §2.7). После ADR-159 фильтр
      // упростился (не нужно исключать `activeStreams` — стримов нет).
      const subsMap = await this.readWsSubs();
      const nonPopularRounds = ongoingRounds.filter(
        (r) => (subsMap.get(r.lichessRoundId) ?? 0) === 0,
      );

      const toFetch: typeof nonPopularRounds = [];
      if (nonPopularRounds.length > 0) {
        this.pollOffset = this.pollOffset % nonPopularRounds.length;
        const take = Math.min(
          MAX_PGN_POLLS_PER_CYCLE,
          nonPopularRounds.length,
        );
        for (let i = 0; i < take; i++) {
          toFetch.push(
            nonPopularRounds[(this.pollOffset + i) % nonPopularRounds.length],
          );
        }
        this.pollOffset = (this.pollOffset + take) % nonPopularRounds.length;
      }

      // KS-2356: summary state of polling queue для диагностики «почему
      // конкретный round долго не получает партии».
      this.logger.log(
        `[broadcast-sync] poll-cycle ongoing=${ongoingRounds.length} ` +
          `queued=${nonPopularRounds.length} ` +
          `picked=${toFetch.length} pollOffset=${this.pollOffset}`,
      );

      for (let i = 0; i < toFetch.length; i++) {
        // KS-4859 / ADR-159 §3.1 п.4. Раньше здесь сначала пытались
        // `startStream()` как fallback (ADR-156 §2.5). Стримов больше
        // нет — сразу идём в PGN poll.
        if (i > 0) await this.rateLimitDelay();
        await this.fetchAndProcessRoundPgn(toFetch[i].lichessRoundId).catch(
          (e: unknown) =>
            this.logger.warn(
              `[broadcast-sync] PGN poll failed for ${toFetch[i].lichessRoundId}: ${formatFetchError(e)}`,
            ),
        );
      }

      // KS-4832 / ADR-155 §2.4. Phase 2 — pending-heal. Идёт после PGN
      // polls, чтобы не отбирать квоту у live-обновлений. Изолирован
      // try/catch, ошибки внутри не валят весь pinned-цикл.
      if (PENDING_HEAL_ENABLED) {
        try {
          await this.runPendingHealPhase();
        } catch (e: unknown) {
          this.logger.warn(
            `[broadcast-sync] pending-heal phase failed: ${(e as Error).message}`,
          );
        }
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

  /**
   * KS-4832 / ADR-155 §2.4. Pending-heal фаза pinned-цикла.
   *
   * Выборка pending-кандидатов, чей `startsAt` в окне [-24 ч, +15 мин].
   * Round-robin по `pendingOffset`. Для каждого кандидата — cooldown-check
   * (Redis-ключ), затем `GET /api/broadcast/-/-/{roundId}` (metadata, НЕ
   * .pgn). При `round.ongoing === true` — UPDATE status='ongoing' и
   * инкремент промоушен-метрики. Cooldown ставится всегда (даже при
   * ошибке), TTL = `PENDING_CHECK_COOLDOWN_TTL`.
   *
   * НЕ запускает `runStream()` — стрим стартует со следующего pinned-цикла
   * (когда раунд уже ongoing) или из `syncBroadcasts`. НЕ трогает `.pgn`.
   * НЕ переписывает `startsAt` (это делает `syncBroadcasts` в общей ветке).
   *
   * public — для юнит-тестов (мок PrismaService/RedisService).
   */
  async runPendingHealPhase(): Promise<void> {
    const now = new Date();
    const upperBound = new Date(now.getTime() + PENDING_WINDOW_UPPER_MS);
    const lowerBound = new Date(now.getTime() - PENDING_WINDOW_LOWER_MS);

    const candidates = await this.prisma.broadcastRound.findMany({
      where: {
        status: 'pending',
        startsAt: {
          gte: lowerBound,
          lte: upperBound,
        },
      },
      select: {
        id: true,
        lichessRoundId: true,
        startsAt: true,
        broadcastId: true,
      },
      // Стабильный порядок для round-robin по pendingOffset.
      orderBy: { id: 'asc' },
    });

    if (candidates.length === 0) {
      this.logger.log(
        '[broadcast-sync] pending-heal: no candidates in window',
      );
      return;
    }

    this.pendingOffset = this.pendingOffset % candidates.length;
    const take = Math.min(MAX_PENDING_CHECKS_PER_CYCLE, candidates.length);
    const picked: typeof candidates = [];
    for (let i = 0; i < take; i++) {
      picked.push(candidates[(this.pendingOffset + i) % candidates.length]);
    }
    this.pendingOffset = (this.pendingOffset + take) % candidates.length;

    this.logger.log(
      `[broadcast-sync] pending-heal: candidates=${candidates.length} ` +
        `picked=${picked.length} pendingOffset=${this.pendingOffset}`,
    );

    for (let i = 0; i < picked.length; i++) {
      const r = picked[i];
      const cooldownKey = `${PENDING_CHECK_COOLDOWN_KEY_PREFIX}${r.lichessRoundId}`;
      // Cooldown-check: если ключ есть — пропускаем этот раунд в этом цикле.
      let cooldownActive = false;
      try {
        const existing = await this.redis.get(cooldownKey);
        cooldownActive = existing !== null;
      } catch (e: unknown) {
        this.logger.warn(
          `[broadcast-sync] pending-heal cooldown-read failed for ${r.lichessRoundId}: ${(e as Error).message}`,
        );
      }
      if (cooldownActive) {
        continue;
      }

      // Между запросами — общий rate-limit delay (у нас в pinned-цикле
      // всегда была задержка между вызовами lichessFetch).
      if (i > 0) await this.rateLimitDelay();

      let result: 'promoted' | 'still_pending' | 'not_found' | 'err' = 'err';
      try {
        const url = `${LICHESS_API}/broadcast/-/-/${r.lichessRoundId}`;
        // KS-4846 §2.4.1. Endpoint-hint `pending_metadata` — тот же URL
        // используется и в refresh-loop как `round_metadata`.
        const res = await this.lichessFetch(
          url,
          {
            headers: {
              'User-Agent': 'Kingside/1.0 (https://kingside.app)',
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          },
          'pending_metadata',
        );
        if (res.status === 404) {
          result = 'not_found';
          this.logger.warn(
            `[broadcast-sync] pending-heal ${r.lichessRoundId}: 404 (round removed on Lichess)`,
          );
          // KS-4845. Тело не читаем — дренируем, иначе socket leak.
          await res.body?.cancel().catch(() => {});
        } else if (!res.ok) {
          result = 'err';
          this.logger.warn(
            `[broadcast-sync] pending-heal ${r.lichessRoundId}: HTTP ${res.status}`,
          );
          // KS-4845. Тело не читаем — дренируем, иначе socket leak.
          await res.body?.cancel().catch(() => {});
        } else {
          const body = (await res.json()) as {
            round?: { finished?: boolean; ongoing?: boolean };
          };
          const ongoing = body.round?.ongoing === true;
          const finished = body.round?.finished === true;
          if (finished || ongoing) {
            const newStatus = finished ? 'finished' : 'ongoing';
            await this.prisma.broadcastRound.update({
              where: { id: r.id },
              data: { status: newStatus },
            });
            result = 'promoted';
            this.logger.log(
              `[broadcast-sync] pending-heal ${r.lichessRoundId}: pending → ${newStatus}`,
            );
            if (r.startsAt) {
              const delaySec = (now.getTime() - r.startsAt.getTime()) / 1000;
              this.metrics.observePendingPromotionDelay(delaySec);
            }
            // KS-4859 / ADR-159 §3.1 п.2. Раньше pending-heal при
            // промоушене `pending → ongoing` вызывал `startStream()`.
            // Стримов больше нет — статус обновлён, live-обновления
            // подхватит fast poll (если у раунда есть подписчики) или
            // slow pinned poll (если нет).
            // Постановка prerender для transition'а — как в
            // `refreshNonTop20RoundStatuses`.
            this.prerender.enqueueFireAndForget({
              kind: 'broadcast',
              tid: r.broadcastId,
              rid: r.id,
            });
            this.prerender.enqueueFireAndForget({
              kind: 'list',
              route: '/broadcasts',
            });
          } else {
            result = 'still_pending';
          }
        }
      } catch (e: unknown) {
        result = 'err';
        this.logger.warn(
          `[broadcast-sync] pending-heal ${r.lichessRoundId} threw: ${formatFetchError(e)}`,
        );
      }

      this.metrics.recordPendingCheck(result);

      // Cooldown ставится всегда, даже при ошибке — не долбить один и
      // тот же раунд в каждом цикле. TTL=60 сек = один pinned-тик.
      try {
        await this.redis.set(
          cooldownKey,
          '1',
          'EX',
          PENDING_CHECK_COOLDOWN_TTL,
        );
      } catch (e: unknown) {
        this.logger.warn(
          `[broadcast-sync] pending-heal cooldown-set failed for ${r.lichessRoundId}: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * KS-3254. Принудительный re-sync раунда: сбрасывает cooldown +
   * PGN-hash ключи в Redis (иначе `fetchAndProcessRoundPgn` решит, что
   * содержимое не менялось со времени прошлого poll'а), и стучится в
   * Lichess за PGN снова. Используется для устранения legacy-расхождений
   * после KS-3229 — в раундах с broken-записями (1 партия из 5+ из-за
   * Site=URL split-bug) повторный sync через нормальный poll-цикл не
   * проходит, потому что cooldown / hash скипают fetch.
   *
   * Вызывается через `POST /internal/rounds/:lichessRoundId/force-resync`.
   */
  async forceResyncRound(lichessRoundId: string): Promise<{
    fetched: boolean;
    gamesBefore: number;
    gamesAfter: number;
  }> {
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId },
    });
    if (!round) {
      throw new Error(`Round ${lichessRoundId} not found in DB`);
    }
    const gamesBefore = await this.prisma.broadcastGame.count({
      where: { roundId: round.id },
    });

    // Сбрасываем Redis-ключи, которые иначе делают early-return:
    //   - pgn-hash (одинаковый PGN не перепарсивается)
    //   - pgn-fetch-cooldown (после 4xx/empty Lichess мы ставим cooldown,
    //     чтобы не долбить впустую)
    await this.redis
      .del(
        `broadcast:pgn-hash:${lichessRoundId}`,
        `broadcast:pgn-fetch-cooldown:${lichessRoundId}`,
      )
      .catch(() => {});

    let fetched = true;
    try {
      await this.fetchAndProcessRoundPgn(lichessRoundId);
    } catch (e: unknown) {
      this.logger.error(
        `[broadcast-sync] KS-3254 force-resync ${lichessRoundId} failed: ${(e as Error).message}`,
      );
      fetched = false;
    }

    const gamesAfter = await this.prisma.broadcastGame.count({
      where: { roundId: round.id },
    });
    this.logger.log(
      `[broadcast-sync] KS-3254 force-resync ${lichessRoundId}: ` +
        `games ${gamesBefore} → ${gamesAfter} (fetched=${fetched})`,
    );
    return { fetched, gamesBefore, gamesAfter };
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
      // KS-4845. Тело не читаем — дренируем, иначе socket leak.
      await res.body?.cancel().catch(() => {});
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
    // KS-4859 / ADR-159 §2.3. Backend больше не открывает broadcast-стримы
    // к Lichess (клиент делает direct-stream). Все ongoing раунды с
    // subs >= 1 обслуживает fast poll (30 сек, §2.7), с subs = 0 —
    // round-robin через phase 1 pinned poll (5 циклов в минуту, §2.8).
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
        if (!res.ok) {
          // KS-4845. Тело не читаем — дренируем перед throw.
          await res.body?.cancel().catch(() => {});
          throw new Error(`Lichess API error: ${res.status}`);
        }
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
            `[broadcast-sync] fetchActiveBroadcasts attempt ${attempt + 1} failed: ${formatFetchError(e)}. Retry in ${delay}ms`,
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

    // KS-3266: если в БД уже лежит chessResultsTournamentId, который
    // отличается от свежеизвлечённого из Lichess metadata — это значит,
    // `BroadcastStandingsSyncService.tryResolveTournamentIdByTitle`
    // запускался ранее и нашёл правильный tnr-id по title (Lichess
    // отдаёт «битый» tnr1349842 для Halocher Schachtage, мы фолбэком
    // нашли правильный tnr1422274). Не перезаписываем — иначе loop:
    // sync → reset → /crosstable → fallback → UPDATE → sync → reset...
    //
    // Логика: если DB-значение divergent от Lichess-извлечения —
    // считаем что DB-значение «победитель» (его поставил наш fallback
    // намеренно). Сохраняем И chessResultsTournamentId, И standingsUrl
    // (canonical URL `https://chess-results.com/tnrXXX.aspx`, который
    // fallback тоже пишет).
    const existing = await this.prisma.broadcast.findUnique({
      where: { lichessId: bc.tour.id },
      select: { chessResultsTournamentId: true, standingsUrl: true },
    });
    const useOverride =
      existing?.chessResultsTournamentId != null &&
      existing.chessResultsTournamentId !== extracted.tournamentId;
    if (useOverride) {
      this.logger.log(
        `[broadcast-sync] preserve override for ${bc.tour.id}: ` +
          `DB tnr=${existing.chessResultsTournamentId} vs Lichess tnr=${extracted.tournamentId ?? 'null'}. ` +
          `Likely set by KS-3266 title-fallback — skip overwrite.`,
      );
    }
    const effectiveChessResultsTid = useOverride
      ? existing.chessResultsTournamentId
      : extracted.tournamentId;
    const effectiveStandingsUrl = useOverride
      ? existing.standingsUrl
      : standingsUrl;

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
      standingsUrl: effectiveStandingsUrl,
      imageUrl: bc.tour.image ?? null,
      startDate: dates?.[0] ? new Date(dates[0]) : null,
      endDate: dates?.[1] ? new Date(dates[1]) : null,
      // KS-1735 — поля для crosstable-фичи (ADR-023 §2.3).
      chessResultsTournamentId: effectiveChessResultsTid,
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
    // KS-4205: читаем предыдущий status ДО upsert'а, чтобы понимать
    // transition'ы (pending→ongoing, *→finished). При первом
    // появлении раунда `existing === null` → транзишн считается «из
    // несуществующего», prerender ставится так же.
    const existing = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId: round.id },
      select: { status: true },
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
    // KS-4205 §10 #11. Transition'ы статуса раунда → prerender:
    //   *→ongoing  (старт раунда):      broadcast/list
    //   *→finished (завершение раунда): broadcast/list
    // На переходе pending→pending или sync без смены status — no-op
    // (иначе SQS заполнится повторами sync-цикла).
    const prevStatus = existing?.status ?? null;
    if (status !== prevStatus && (status === 'ongoing' || status === 'finished')) {
      this.prerender.enqueueFireAndForget({
        kind: 'broadcast',
        tid: broadcast.id,
        rid: upserted.id,
      });
      this.prerender.enqueueFireAndForget({
        kind: 'list',
        route: '/broadcasts',
      });
    }

    // KS-4847 / ADR-158 §2.1. Если Lichess в общем listing отдал `games[]`
    // для этого раунда (обычно только для top-20 бродкастов) — подхватить
    // пары сразу, без ожидания refreshNonTop20-цикла. Правило «pgn NOT NULL
    // → не трогать» соблюдено в `upsertPairingsFromMetadata`.
    if (Array.isArray(round.games) && round.games.length > 0) {
      try {
        const changed = await this.upsertPairingsFromMetadata(
          upserted.id,
          round.games,
        );
        if (changed > 0) {
          this.prerender.enqueueFireAndForget({
            kind: 'broadcast',
            tid: broadcast.id,
            rid: upserted.id,
          });
        }
      } catch (e: unknown) {
        this.logger.warn(
          `[broadcast-sync] upsertPairingsFromMetadata(upsertRound) failed for round=${upserted.id.slice(0, 8)}: ${(e as Error).message}`,
        );
      }
    }

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
    // KS-4832 / ADR-156 §2.1. Полный обход non-top-20 раундов раскладывается
    // на несколько циклов через квоту `MAX_ROUND_METADATA_CHECKS_PER_CYCLE`
    // и Redis-cursor. Приоритет: ongoing → pending → finished; внутри
    // группы — самые давно проверенные (updatedAt ASC).
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

    const eligible = candidates.filter(
      (r) => !upsertedRoundIds.has(r.lichessRoundId),
    );
    if (eligible.length === 0) return;

    // Приоритетная сортировка. Сортируем в JS — набор небольшой (≤ пары
    // тысяч), Prisma не умеет ORDER BY по CASE напрямую без raw SQL.
    const priority = (status: string): number =>
      status === 'ongoing' ? 0 : status === 'pending' ? 1 : 2;
    eligible.sort((a, b) => priority(a.status) - priority(b.status));

    // Redis-cursor (integer offset) — TTL 1 ч. При смене общего количества
    // раундов допустима лёгкая сдвижка выборки — следующий проход покроет.
    let cursor = 0;
    try {
      const raw = await this.redis.get(REFRESH_CURSOR_KEY);
      const parsed = raw ? parseInt(raw, 10) : 0;
      cursor = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] refreshNonTop20 cursor-read failed: ${(e as Error).message}`,
      );
    }
    if (cursor >= eligible.length) cursor = 0;

    const quota = MAX_ROUND_METADATA_CHECKS_PER_CYCLE;
    const toFetch = eligible.slice(cursor, cursor + quota);
    const nextCursor =
      cursor + toFetch.length >= eligible.length ? 0 : cursor + toFetch.length;

    this.logger.log(
      `[broadcast-sync] refreshNonTop20RoundStatuses: pool=${eligible.length} ` +
        `cursor=${cursor} quota=${quota} picked=${toFetch.length} nextCursor=${nextCursor}`,
    );

    try {
      await this.redis.set(
        REFRESH_CURSOR_KEY,
        String(nextCursor),
        'EX',
        REFRESH_CURSOR_TTL,
      );
    } catch (e: unknown) {
      this.logger.warn(
        `[broadcast-sync] refreshNonTop20 cursor-set failed: ${(e as Error).message}`,
      );
    }

    for (const r of toFetch) {
      try {
        await this.rateLimitDelay();
        await this.refreshOneRoundMetadata(r, 'round_metadata');
      } catch (e: unknown) {
        this.logger.warn(
          `[broadcast-sync] round-metadata fetch ${r.lichessRoundId} threw: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * KS-4847 / ADR-158 §2.1. Одна проверка metadata раунда:
   *   - fetch `/api/broadcast/-/-/{lichessRoundId}`
   *   - mirror `status` в БД (pending / ongoing / finished)
   *   - upsert пар из `body.games?[]` (см. `upsertPairingsFromMetadata`)
   *   - при перехода status → ongoing / finished — enqueue prerender
   *
   * Вызывается из `refreshNonTop20RoundStatuses` (батч) и из
   * `runFastPollTick` (одиночный вызов для pending раундов с зрителями,
   * §2.6). `endpointHint` — для метки endpoint в счётчике исходящих
   * запросов (round_metadata vs pending_metadata).
   */
  private async refreshOneRoundMetadata(
    r: { id: string; lichessRoundId: string; status: string },
    endpointHint: LichessEndpointLabel,
  ): Promise<{ statusChanged: boolean; pairingsUpserted: number }> {
    const url = `${LICHESS_API}/broadcast/-/-/${r.lichessRoundId}`;
    const res = await this.lichessFetch(
      url,
      {
        headers: {
          'User-Agent': 'Kingside/1.0 (https://kingside.app)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      endpointHint,
    );
    if (!res.ok) {
      if (res.status === 404) {
        this.logger.warn(
          `[broadcast-sync] round ${r.lichessRoundId} not found on Lichess (404)`,
        );
      } else {
        this.logger.warn(
          `[broadcast-sync] round-metadata fetch ${r.lichessRoundId} failed: HTTP ${res.status}`,
        );
      }
      // KS-4845. Тело не читаем — дренируем.
      await res.body?.cancel().catch(() => {});
      return { statusChanged: false, pairingsUpserted: 0 };
    }
    const body = (await res.json()) as {
      round?: { finished?: boolean; ongoing?: boolean };
      games?: LichessRoundGame[];
    };
    const finished = body.round?.finished === true;
    const ongoing = body.round?.ongoing === true;
    const newStatus = finished ? 'finished' : ongoing ? 'ongoing' : 'pending';
    let statusChanged = false;
    if (newStatus !== r.status) {
      statusChanged = true;
      this.logger.log(
        `[broadcast-sync] round ${r.lichessRoundId} status mirror: ${r.status} → ${newStatus}`,
      );
      await this.prisma.broadcastRound.update({
        where: { id: r.id },
        data: { status: newStatus },
      });
      // KS-4205 §10 #11. Transition'ы в metadata-fetch mirror-loop.
      if (newStatus === 'ongoing' || newStatus === 'finished') {
        const round = await this.prisma.broadcastRound.findUnique({
          where: { id: r.id },
          select: { broadcastId: true },
        });
        if (round) {
          this.prerender.enqueueFireAndForget({
            kind: 'broadcast',
            tid: round.broadcastId,
            rid: r.id,
          });
          this.prerender.enqueueFireAndForget({
            kind: 'list',
            route: '/broadcasts',
          });
        }
      }
    }

    // KS-4847 / ADR-158 §2.1. Upsert пар из metadata — работает для всех
    // статусов, но особенно важен для pending (без стрима/PGN пары
    // приходят только отсюда).
    const pairingsUpserted = await this.upsertPairingsFromMetadata(
      r.id,
      body.games,
    );
    if (pairingsUpserted > 0 && !statusChanged) {
      // KS-4847 §3.3 (тг. инвалидации). Если пары изменились без смены
      // статуса — тоже надо пересобрать HTML раунда, чтобы SEO-снимок
      // отражал актуальные пары.
      const round = await this.prisma.broadcastRound.findUnique({
        where: { id: r.id },
        select: { broadcastId: true },
      });
      if (round) {
        this.prerender.enqueueFireAndForget({
          kind: 'broadcast',
          tid: round.broadcastId,
          rid: r.id,
        });
      }
    }
    return { statusChanged, pairingsUpserted };
  }

  /**
   * KS-4847 / ADR-158 §2.1 / §2.2. Upsert пар из ответа Lichess metadata
   * в `BroadcastGame`. Правило (§2.1):
   *  - Если существующая запись найдена по `(roundId, lichessGameId)` и у
   *    неё `pgn IS NOT NULL` — не трогаем (PGN — источник истины после
   *    старта).
   *  - Если существующая запись с `pgn IS NULL` — обновляем players/fen/
   *    ratings (Lichess может поправить состав до старта).
   *  - Если записи нет — создаём с `pgn=null`, `result=null`.
   *
   * Возвращает число upserted / created записей (для метрик и триггера
   * prerender-инвалидации).
   */
  private async upsertPairingsFromMetadata(
    roundDbId: string,
    games: LichessRoundGame[] | undefined,
  ): Promise<number> {
    if (!games || games.length === 0) return 0;
    let changed = 0;
    for (const g of games) {
      if (!g.id) continue; // без id мы не сможем дедуплицировать
      const players = Array.isArray(g.players) ? g.players : [];
      const whitePlayer = players[0]?.name?.trim() || null;
      const blackPlayer = players[1]?.name?.trim() || null;
      const whiteElo =
        typeof players[0]?.rating === 'number' &&
        Number.isFinite(players[0].rating)
          ? players[0].rating!
          : null;
      const blackElo =
        typeof players[1]?.rating === 'number' &&
        Number.isFinite(players[1].rating)
          ? players[1].rating!
          : null;
      const currentFen =
        typeof g.fen === 'string' && g.fen.length > 0 ? g.fen : STARTING_FEN;

      const existing = await this.prisma.broadcastGame.findFirst({
        where: { roundId: roundDbId, lichessGameId: g.id },
        select: { id: true, pgn: true, whitePlayer: true, blackPlayer: true, whiteElo: true, blackElo: true, currentFen: true },
      });
      if (existing) {
        if (existing.pgn !== null && existing.pgn !== undefined) {
          // §2.1 п.3: PGN уже пришёл — источник истины, metadata не
          // перезаписывает.
          continue;
        }
        // Обновляем только если что-то реально поменялось (сохраняет
        // updatedAt актуальным только для настоящих изменений).
        const differs =
          existing.whitePlayer !== whitePlayer ||
          existing.blackPlayer !== blackPlayer ||
          existing.whiteElo !== whiteElo ||
          existing.blackElo !== blackElo ||
          existing.currentFen !== currentFen;
        if (!differs) continue;
        await this.prisma.broadcastGame.update({
          where: { id: existing.id },
          data: {
            whitePlayer,
            blackPlayer,
            whiteElo,
            blackElo,
            currentFen,
          },
        });
        changed += 1;
      } else {
        await this.prisma.broadcastGame.create({
          data: {
            roundId: roundDbId,
            lichessGameId: g.id,
            whitePlayer,
            blackPlayer,
            whiteElo,
            blackElo,
            currentFen,
            pgn: null,
            result: null,
          },
        });
        changed += 1;
      }
    }
    return changed;
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
        // KS-4845. Тело не читаем — дренируем перед return.
        await res.body?.cancel().catch(() => {});
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

    // KS-3230 strict mode: проверяем уникальность lichessGameId в пакете
    // до upsert'ов. До KS-3229 баг с Site=venue приводил к тому, что все
    // 5 партий получали один id и upsert по (roundId, lichessGameId)
    // молча перезаписывал одну запись 5 раз. Теперь — warn + skip
    // раунда: лучше остаться с уже сохранёнными данными, чем продолжать
    // схлопывать партии. На следующей итерации Lichess может прислать
    // корректный PGN (например после фикса парсера), и мы догоним.
    const duplicateIds = findDuplicateGameIds(games);
    if (duplicateIds.length > 0) {
      this.logger.warn(
        `[broadcast-sync] KS-3230 strict-mode: round=${roundId.slice(0, 8)} ` +
          `broadcast=${round.broadcastId.slice(0, 8)} has ${duplicateIds.length} ` +
          `duplicate lichessGameId(s) in PGN batch — SKIP. ` +
          `Dupes: ${duplicateIds.slice(0, 3).join(', ')}${duplicateIds.length > 3 ? ', ...' : ''}. ` +
          `Likely PGN parser regression (см. KS-3229).`,
      );
      return;
    }

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
          // KS-4208 §7.3.7. Завершение партии — переход финального
          // result (null/'*'/иной) → '1-0' / '0-1' / '1/2-1/2'. Эта
          // ветка только для существующих партий: новые с конечным
          // result сразу покрывает старт-hook в else-ветке.
          // `isNewFinalResult` уже посчитан выше с учётом existing.result.
          if (isNewFinalResult && game.result && game.result !== '*') {
            this.prerender.enqueueFireAndForget({
              kind: 'broadcast',
              tid: round.broadcastId,
              rid: round.id,
              gid: existing.id,
            });
          }
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
          // KS-4208 / ADR-128 §7.3.7. Новая партия в раунде — старт
          // партии. Карточка `/broadcasts/:tid/:rid/:gid` должна стать
          // индексируемой пока партия идёт (SEO под «{white} vs {black}
          // live»). isNewGame=true в этой ветке по определению.
          this.prerender.enqueueFireAndForget({
            kind: 'broadcast',
            tid: round.broadcastId,
            rid: round.id,
            gid: created.id,
          });
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
            // KS-4847 / ADR-158 §2.3. Рейтинги нужны фронту для рендера
            // карточек пар (в т.ч. на pending раундах до старта партий).
            whiteElo: g.whiteElo ?? null,
            blackElo: g.blackElo ?? null,
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

  /**
   * KS-3230: parsePgnGames + parseElo + computeFenAndLastUci вынесены в
   * ./pgn-parser как чистые функции для регрессионного тестирования.
   * Здесь оставлен тонкий method-wrapper, чтобы внешний API класса не
   * менялся, а вызов внутри processPgnUpdate шёл через единый источник.
   */
  private parsePgnGames(rawPgn: string): ParsedGamePure[] {
    return parsePgnGamesPure(rawPgn);
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
