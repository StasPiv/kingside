/**
 * KS-2160 (ADR-034 §2.1, §10.1 B0+B1). Базовые типы и ENV-keys для
 * системы synthetic users.
 *
 * Декомпозиция KS-2159 (synthetic user emulation):
 *   - KS-2160 (этот тикет) — schema, типы, ENV-keys.
 *   - KS-2161 — Stockfish pool / runner / engine.
 *   - KS-2162 — генерация профилей (country/locale/style/avatar).
 *   - KS-2164 — presence / scheduler.
 *   - ~KS-2167 — public exclusion — отменена пользователем 30.04.
 *     Synthetic = полноценный пользователь и виден в публичных
 *     листингах/чартах как обычный.
 *
 * Здесь — только типы + константы. Никакой бизнес-логики, никаких
 * зависимостей от других пакетов кроме встроенных. Импортируется в
 * `apps/api`, `apps/game-service` и (позже) в `apps/web` для рендера
 * флага страны в профиле.
 */

/**
 * Двухбуквенный ISO-3166-1 alpha-2 (RU, US, IN, BR…). Хранится в
 * `users.country` (см. `packages/db/prisma/schema.prisma`,
 * миграция `20260430120000_add_synthetic_fields`). Тип сделан
 * branded-string'ом, чтобы в TS нельзя было случайно пихнуть
 * произвольную строку — на границе используется `assertCountryCode`
 * либо валидатор класса (DTO).
 */
export type CountryCodeISO = string & { readonly __brand: 'CountryCodeISO' };

/**
 * Стиль игры synthetic-юзера. Влияет на параметры Stockfish-pool
 * (skill level, MultiPV, время на ход) и поведение presence (KS-2161+).
 *
 * Расширяется по мере роста игровых стилей; на B0 фиксируем 4 типа,
 * соответствующие диапазонам ELO в `MATCHMAKING_BOTS`:
 *   - `beginner`  — 800..1200
 *   - `casual`    — 1200..1600
 *   - `competitive` — 1600..1900
 *   - `expert`    — 1900..2200
 */
export type SyntheticPlayStyle =
  | 'beginner'
  | 'casual'
  | 'competitive'
  | 'expert';

/**
 * Метаданные synthetic-пользователя. Читаются на фронте для рендера
 * профиля (флаг страны, локаль для приветствий), на бэке — scheduler'ом
 * (KS-2164) и engine-runner'ом (KS-2161).
 *
 * НЕ хранится одной JSON-колонкой: country / locale — отдельные поля
 * на `User` (locale уже существовал). `style` хранится отдельно в
 * profile-таблице, которую заводит KS-2162 — здесь только тип-фасад
 * для чтения.
 */
export interface SyntheticUserMetadata {
  /** ISO-3166-1 alpha-2, например `'RU'`, `'US'`. */
  country: CountryCodeISO;
  /** BCP-47 locale, например `'ru-RU'`, `'en-US'`. Зеркалит `User.locale`. */
  locale: string;
  /** Игровой стиль, см. {@link SyntheticPlayStyle}. */
  style: SyntheticPlayStyle;
}

/**
 * Конфигурация synthetic-runner'а. Все поля nullable-имеют дефолт,
 * env-override через `SyntheticEnvKey` (см. ниже).
 */
export interface SyntheticConfig {
  /**
   * Включён ли scheduler. По умолчанию false — пакет зарелизится в
   * idle-режиме, devops флипнет флаг через task-def (см. KS-2164).
   */
  schedulerEnabled: boolean;
  /**
   * Сколько одновременно живых synthetic-сессий поддерживать.
   * Default 100. Скейлит Stockfish-pool в KS-2161.
   */
  poolSize: number;
  /**
   * Если живая matchmaking-очередь больше N — приостанавливаем приём
   * synthetic-партий, чтобы не конкурировать с реальными игроками за
   * пул соединений / engine'ы. Default 50.
   */
  disableAtLiveQueueLen: number;
  /**
   * Стартовый «пробег» для cold-start: на свежей среде scheduler
   * генерирует N партий с разными synthetic-парами, прогревает
   * рейтинги. Default 200.
   */
  bootstrapTargetGames: number;
  /**
   * Расписание присутствия / новых партий: cron-выражения для пиков
   * активности (например, `"0 19 * * *"` — вечерний прайм-тайм).
   * Список, потому что разные таймзоны / разные плейстайлы.
   */
  schedule: string[];
  /**
   * TTL Redis-сессии synthetic-юзера (presence). После TTL без
   * heartbeat'а scheduler перевыбирает следующего. Default 600 sec.
   */
  sessionTtlSec: number;
  /**
   * Размер батча при пакетной генерации профилей. Default 20.
   * На больших значениях нагружается Stockfish-pool равномернее.
   */
  profileBatchSize: number;
  /**
   * Сколько раз retry-ить failed engine-tick (Stockfish crash, network
   * flap). Default 3.
   */
  engineRetryAttempts: number;
}

/**
 * KS-2160. Полный список env-keys пакета. Импортировать как:
 *
 * ```ts
 * import { SyntheticEnvKey } from '@kingside/shared';
 * if (process.env[SyntheticEnvKey.SchedulerEnabled] === 'true') { ... }
 * ```
 *
 * Используется во всех 5 тикетах KS-2161..2167. Добавление нового ключа
 * — здесь и нигде ещё (no `process.env.SYNTHETIC_*` строковых литералов
 * в бизнес-коде).
 */
export const SyntheticEnvKey = {
  /** Boolean. `'true'` → scheduler стартует на onModuleInit (KS-2164). */
  SchedulerEnabled: 'SYNTHETIC_SCHEDULER_ENABLED',
  /** Int. Размер пула одновременных synthetic-сессий. */
  PoolSize: 'SYNTHETIC_POOL_SIZE',
  /** Int. Лимит длины live-очереди, выше которого новые synthetic-партии не запускаются. */
  DisableAtLiveQueueLen: 'SYNTHETIC_DISABLE_AT_LIVE_QUEUE_LEN',
  /** Int. Сколько партий нагенерить на cold-start (bootstrap-прогрев рейтингов). */
  BootstrapTargetGames: 'SYNTHETIC_BOOTSTRAP_TARGET_GAMES',
  /** Cron string. Стартовый таймер-расписание. */
  ScheduleStart: 'SYNTHETIC_SCHEDULE_START',
  /** Cron string. Расписание прайм-тайма (повышенный наплыв). */
  SchedulePeak: 'SYNTHETIC_SCHEDULE_PEAK',
  /** Cron string. Расписание ночного режима (снижение активности). */
  ScheduleNight: 'SYNTHETIC_SCHEDULE_NIGHT',
  /** Int. TTL Redis-сессии synthetic-юзера (presence) в секундах. */
  SessionTtlSec: 'SYNTHETIC_SESSION_TTL_SEC',
  /** Int. Размер батча генерации профилей. */
  ProfileBatchSize: 'SYNTHETIC_PROFILE_BATCH_SIZE',
  /** Int. Кол-во retry'ев на failed engine-tick. */
  EngineRetryAttempts: 'SYNTHETIC_ENGINE_RETRY_ATTEMPTS',
} as const;

export type SyntheticEnvKeyName =
  (typeof SyntheticEnvKey)[keyof typeof SyntheticEnvKey];

/**
 * Дефолты {@link SyntheticConfig}. Используется backend'ом, чтобы
 * прикладной код не дублировал значения. Перебивается env'ом через
 * `SyntheticEnvKey`.
 */
export const SYNTHETIC_CONFIG_DEFAULTS: SyntheticConfig = {
  schedulerEnabled: false,
  poolSize: 100,
  disableAtLiveQueueLen: 50,
  bootstrapTargetGames: 200,
  schedule: [],
  sessionTtlSec: 600,
  profileBatchSize: 20,
  engineRetryAttempts: 3,
};

/**
 * Mapping play-style → диапазон рейтинга. Используется генератором
 * профилей (KS-2162) и runner'ом (KS-2161) для подбора Stockfish skill
 * level.
 */
export const SYNTHETIC_PLAY_STYLE_RATING_RANGE: Record<
  SyntheticPlayStyle,
  { min: number; max: number }
> = {
  beginner: { min: 800, max: 1200 },
  casual: { min: 1200, max: 1600 },
  competitive: { min: 1600, max: 1900 },
  expert: { min: 1900, max: 2200 },
};

/**
 * Простая валидация ISO-3166-1 alpha-2 на TS-уровне. Используется в
 * KS-2162 (генератор) и в DTO (`@Length(2,2)` + `@Matches(/^[A-Z]{2}$/)`)
 * — здесь общая функция, чтобы фронт и бэк сошлись.
 */
export function isCountryCodeISO(value: unknown): value is CountryCodeISO {
  return (
    typeof value === 'string' &&
    value.length === 2 &&
    /^[A-Z]{2}$/.test(value)
  );
}
