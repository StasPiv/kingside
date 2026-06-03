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

/** ADR-106 §2.6: дефолтный порог 0.3. */
export const PRECISION_MAIA_DEFAULT_THRESHOLD = 0.3;

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
