/**
 * KS-2123. Конфигурация таймаутов archive-importer.
 *
 * Контекст: дневной импортёр TWIC (`kingside-archive-importer-daily`,
 * EventBridge cron 20:00 UTC) с 24-04-2026 стабильно падает с exit 124,
 * упираясь в hard-таймаут `tickOnce` (8 мин). Корень — рост размера TWIC
 * weekly: парсинг ~7K партий стал занимать ~17 мин против 30-120 сек,
 * заложенных в исходный ADR-020 §4.2.
 *
 * Решение: дефолты 30 мин (`tickOnce`) / 35 мин (backstop). Значения
 * вынесены в env, чтобы при следующем «нормальном» росте можно было
 * переопределить через task definition без redeploy кода.
 *
 * Соотношение:
 *   - tickOnce timeout < backstop — backstop ловит зависание именно
 *     timeout-ветки (Promise.race / EMF flush / Nest shutdown hooks).
 *   - оба значения < ECS task `stopTimeout` поправлять НЕ требуется:
 *     `stopTimeout` отвечает за SIGTERM→SIGKILL после graceful shutdown,
 *     а не за прикладной таймаут. Если контейнер не успеет завершиться
 *     за 120 сек после внутреннего exit — отдельная задача devops.
 *
 * Для override:
 *   IMPORTER_TICK_TIMEOUT_MS=2400000      # 40 мин
 *   IMPORTER_BACKSTOP_TIMEOUT_MS=2700000  # 45 мин
 */

/** 30 минут — глобальный таймаут одного `tickOnce` (KS-2123 default). */
export const DEFAULT_TICK_ONCE_TIMEOUT_MS = 30 * 60 * 1000;

/** 35 минут — backstop в `importer-once.ts` (на 5 мин выше tickOnce). */
export const DEFAULT_BACKSTOP_TIMEOUT_MS = 35 * 60 * 1000;

const TICK_TIMEOUT_ENV = 'IMPORTER_TICK_TIMEOUT_MS';
const BACKSTOP_TIMEOUT_ENV = 'IMPORTER_BACKSTOP_TIMEOUT_MS';

/**
 * Читает env-переменную как положительное целое число миллисекунд.
 * Невалидное значение (отсутствует / NaN / ≤0 / Infinity) → возвращает
 * `defaultMs` без ошибки. На fallback-варианте возвращает второй аргумент
 * touple — это позволяет вызывающему коду залогировать факт fallback'а
 * (для аудита: какие значения реально применены в task definition).
 */
export function resolveTimeoutMs(
  envName: string,
  defaultMs: number,
): { value: number; usedDefault: boolean; rawEnv: string | undefined } {
  const raw = process.env[envName];
  if (raw == null || raw.trim() === '') {
    return { value: defaultMs, usedDefault: true, rawEnv: raw };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: defaultMs, usedDefault: true, rawEnv: raw };
  }
  return { value: Math.floor(parsed), usedDefault: false, rawEnv: raw };
}

/** Резолвит итоговый timeout для `tickOnce` (env > default). */
export function resolveTickOnceTimeoutMs(): number {
  return resolveTimeoutMs(TICK_TIMEOUT_ENV, DEFAULT_TICK_ONCE_TIMEOUT_MS).value;
}

/** Резолвит итоговый backstop timeout для `importer-once.ts` (env > default). */
export function resolveBackstopTimeoutMs(): number {
  return resolveTimeoutMs(BACKSTOP_TIMEOUT_ENV, DEFAULT_BACKSTOP_TIMEOUT_MS).value;
}

/** Имена env-переменных — экспортируются для логов и тестов. */
export const IMPORTER_TIMEOUT_ENV_NAMES = {
  tickOnce: TICK_TIMEOUT_ENV,
  backstop: BACKSTOP_TIMEOUT_ENV,
} as const;
