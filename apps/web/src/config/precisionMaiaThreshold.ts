/**
 * KS-3634 / ADR-104 §8. Порог Maia top-1 probability для фильтрации
 * Precision-пазлов на клиенте. Если Maia предсказывает правильный ход
 * с вероятностью выше порога — пазл считается слишком очевидным для
 * данного ELO и не показывается (или показывается только при исчерпании
 * retry).
 *
 * Константа держится локально в `apps/web` (не в `@kingside/shared`),
 * потому что backend ею не пользуется — фильтр чисто клиентский. Если
 * когда-нибудь понадобится бэкенду — перенесём в shared отдельной
 * задачей.
 */

/** ADR-104 §8: дефолтный порог 0.5. */
export const PRECISION_MAIA_DEFAULT_THRESHOLD = 0.5;

/** Ключ для localStorage override (ADR-104 §9 UX-калибровка). */
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
