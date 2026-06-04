/**
 * KS-3642 / ADR-106 §2.6. Порог Maia `weakChoiceProb` для фильтрации
 * Precision-пазлов на клиенте. Семантика **инвертирована** относительно
 * отменённой ADR-104: пазл оставляется в выдаче, если Maia с вероятностью
 * `≥ порога` сыграет один из «слабых» ходов (`loss_E > 0.02` от лучшего
 * из top-K). Высокая `maiaWeakChoiceProb` = пазл, на котором игрок с
 * большой вероятностью ошибётся — это то, что мы и хотим тренировать.
 *
 * Откат: порог `1.0` через localStorage → фильтр практически выключен.
 *
 * Константа держится локально в `apps/web` (не в `@kingside/shared`):
 * backend этим порогом не пользуется, фильтр чисто клиентский.
 * Согласовано с координатором при сдаче KS-3642.
 */

/** ADR-106 §2.6: дефолтный порог 0.3 (для одностороннего legacy-API). */
export const PRECISION_MAIA_DEFAULT_THRESHOLD = 0.3;

/**
 * KS-3665 / ADR-106 §2.6. Дефолтный диапазон сложности для двухстороннего
 * слайдера: `[0.3, 1.0]`. Min совпадает с одиночным дефолтом, чтобы при
 * первой инициализации новой версии UI поведение оставалось прежним.
 */
export const PRECISION_MAIA_DEFAULT_RANGE: PrecisionMaiaRange = {
  min: 0.3,
  max: 1,
};

/**
 * KS-3639 / ADR-106 §2.1. Текущая версия алгоритма расчёта
 * `maiaWeakChoiceProb`. Используется фронтом для проверки актуальности
 * метрики: если у пазла `maiaMetricVersion !== MAIA_METRIC_VERSION`,
 * значение считается семантически непригодным (например, унаследовано
 * от отменённой ADR-104) и пазл проходит фильтр как «не размечен»
 * (`NULL`-семантика).
 */
export const MAIA_METRIC_VERSION = 1;

/** Ключ для localStorage override (ADR-106 §2.6 UX-калибровка). */
export const PRECISION_MAIA_THRESHOLD_STORAGE_KEY = 'precision.maiaThreshold';

/**
 * KS-3665 / ADR-106 §2.6. Ключ для двухстороннего диапазона. Хранит
 * JSON-строку `{"min": number, "max": number}`. Старый ключ
 * `precision.maiaThreshold` оставлен для обратной совместимости
 * (читается как `min`, если range-ключа нет; пишется параллельно
 * при изменении нижней границы, чтобы внешние читатели старого ключа
 * — `pickEligiblePrecisionPuzzle` — продолжали работать).
 */
export const PRECISION_MAIA_RANGE_STORAGE_KEY = 'precision.maiaThresholdRange';

/**
 * KS-3665. Диапазон порогов `maiaWeakChoiceProb` для каталога Precision.
 * Оба значения в `[0, 1]`. Инвариант `min <= max`.
 */
export interface PrecisionMaiaRange {
  min: number;
  max: number;
}

/**
 * Прочитать порог из localStorage с валидацией. Если ключ отсутствует,
 * не парсится во float, NaN, или вне диапазона [0, 1] — вернуть
 * `PRECISION_MAIA_DEFAULT_THRESHOLD`.
 *
 * Вынесено в pure-функцию, чтобы можно было протестировать с разными
 * входами через прокидывание `storage` (по умолчанию global localStorage).
 */
export function readPrecisionMaiaThreshold(
  storage: Pick<Storage, 'getItem'> | null | undefined =
    typeof localStorage !== 'undefined' ? localStorage : null,
): number {
  if (!storage) return PRECISION_MAIA_DEFAULT_THRESHOLD;
  let raw: string | null;
  try {
    raw = storage.getItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY);
  } catch {
    return PRECISION_MAIA_DEFAULT_THRESHOLD;
  }
  if (raw == null || raw.trim().length === 0) {
    return PRECISION_MAIA_DEFAULT_THRESHOLD;
  }
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    return PRECISION_MAIA_DEFAULT_THRESHOLD;
  }
  return v;
}

/**
 * KS-3665. Прочитать диапазон `[min, max]` из localStorage с валидацией.
 *
 * Порядок источников:
 *  1. Новый ключ `precision.maiaThresholdRange` (JSON `{min, max}`).
 *  2. Старый ключ `precision.maiaThreshold` (single number) → `{min: V, max: 1}`.
 *  3. `PRECISION_MAIA_DEFAULT_RANGE`.
 *
 * Любая ошибка парсинга / валидации (нечисла, NaN, вне `[0, 1]`,
 * `min > max`, исключение `getItem`) → дефолт.
 *
 * `storage` — DI-точка для тестов; по умолчанию глобальный `localStorage`.
 */
export function readPrecisionMaiaRange(
  storage: Pick<Storage, 'getItem'> | null | undefined =
    typeof localStorage !== 'undefined' ? localStorage : null,
): PrecisionMaiaRange {
  if (!storage) return { ...PRECISION_MAIA_DEFAULT_RANGE };
  let rawRange: string | null;
  try {
    rawRange = storage.getItem(PRECISION_MAIA_RANGE_STORAGE_KEY);
  } catch {
    return { ...PRECISION_MAIA_DEFAULT_RANGE };
  }
  if (rawRange != null && rawRange.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawRange) as { min?: unknown; max?: unknown };
      const min =
        typeof parsed.min === 'number' && Number.isFinite(parsed.min)
          ? parsed.min
          : NaN;
      const max =
        typeof parsed.max === 'number' && Number.isFinite(parsed.max)
          ? parsed.max
          : NaN;
      if (
        Number.isFinite(min) &&
        Number.isFinite(max) &&
        min >= 0 &&
        max <= 1 &&
        min <= max
      ) {
        return { min, max };
      }
    } catch {
      /* fall through to legacy / default */
    }
  }
  // Fallback на legacy single-value ключ. Если он валиден — берём как min,
  // верхняя граница = 1 (как было до KS-3665).
  const legacy = readPrecisionMaiaThreshold(storage);
  if (legacy !== PRECISION_MAIA_DEFAULT_THRESHOLD || rawRange != null) {
    return { min: legacy, max: 1 };
  }
  return { ...PRECISION_MAIA_DEFAULT_RANGE };
}

/**
 * KS-3665. Записать диапазон в localStorage. Параллельно обновляет
 * legacy-ключ `precision.maiaThreshold` (== `range.min`) — чтобы старые
 * читатели (`pickEligiblePrecisionPuzzle` при подборе следующего пазла)
 * продолжали работать без правок. Любая ошибка записи — тихо
 * проглатывается (private-mode и т.п.).
 */
export function writePrecisionMaiaRange(
  range: PrecisionMaiaRange,
  storage: Pick<Storage, 'setItem'> | null | undefined =
    typeof localStorage !== 'undefined' ? localStorage : null,
): void {
  if (!storage) return;
  const safeMin = Math.max(0, Math.min(1, range.min));
  const safeMax = Math.max(safeMin, Math.min(1, range.max));
  try {
    storage.setItem(
      PRECISION_MAIA_RANGE_STORAGE_KEY,
      JSON.stringify({ min: safeMin, max: safeMax }),
    );
    storage.setItem(
      PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
      safeMin.toFixed(2),
    );
  } catch {
    /* localStorage недоступен — пропускаем */
  }
}
