/**
 * KS-3044 — персистенция ориентации доски для сохранённых анализов из
 * «Мастерской». Хранится в `localStorage` под ключом, привязанным к
 * `analysisId` (uuid сохранённого анализа). Backend в таблице
 * `AnalysisResponse` поля для ориентации не имеет, расширять схему БД
 * ради per-user-флага «перевёрнута/нет» избыточно: данные нужны только
 * на том устройстве, где пользователь сейчас работает. localStorage
 * даёт «своё для конкретного пользователя» естественным образом —
 * это session/browser-scoped storage.
 *
 * # Ключ
 *
 * `analysis:orientation:<id>`. `<id>` — analysisId (uuid) сохранённой
 * записи. Для ad-hoc-сессий без id (новый /analysis ещё не успел
 * вызвать createAnalysis) запись не делаем — ориентацию некуда
 * привязать; как только autosave создаст запись и `localIdRef.current`
 * обновится, текущая ориентация будет персистнута явным вызовом из
 * AnalysisPage.
 *
 * # Совместимость
 *
 * Старые анализы — ключа в localStorage нет → `getStoredBoardOrientation`
 * вернёт `null`, страница откроется со стороны белых по умолчанию.
 *
 * # Quota / SecurityError
 *
 * `localStorage` может бросать `QuotaExceededError` / `SecurityError`
 * (приватный режим браузера, заполненная квота). Все методы — best-
 * effort: ошибки ловим и игнорируем, страница продолжает работать без
 * персистенции.
 */

export type BoardOrientation = 'white' | 'black';

const KEY_PREFIX = 'analysis:orientation:';

function storageKey(analysisId: string): string {
  return `${KEY_PREFIX}${analysisId}`;
}

/**
 * Возвращает сохранённую ориентацию для анализа или `null`, если
 * записи нет / id не задан / localStorage недоступен. `null` ⇒
 * вызывающий должен использовать дефолт (`'white'`).
 *
 * Также возвращает `null` при битом значении (что-то кроме
 * `'white'`/`'black'`) — старые формату не задним числом совместимы.
 */
export function getStoredBoardOrientation(
  analysisId: string | undefined | null,
): BoardOrientation | null {
  if (!analysisId) return null;
  try {
    const v = localStorage.getItem(storageKey(analysisId));
    if (v === 'white' || v === 'black') return v;
    return null;
  } catch {
    return null;
  }
}

/**
 * Сохраняет ориентацию. No-op если `analysisId` не задан (ad-hoc
 * сессия без записи в БД).
 */
export function setStoredBoardOrientation(
  analysisId: string | undefined | null,
  orientation: BoardOrientation,
): void {
  if (!analysisId) return;
  try {
    localStorage.setItem(storageKey(analysisId), orientation);
  } catch {
    /* QuotaExceededError / SecurityError — ignore */
  }
}

/**
 * Удаляет сохранённую ориентацию (напр. при удалении анализа).
 * Сейчас не используется в продакшен-коде, но удобно для тестов и
 * на случай будущей кнопки «сбросить настройки анализа».
 */
export function clearStoredBoardOrientation(
  analysisId: string | undefined | null,
): void {
  if (!analysisId) return;
  try {
    localStorage.removeItem(storageKey(analysisId));
  } catch {
    /* ignore */
  }
}
