import i18n from 'i18next';

/**
 * Динамический загрузчик lessons-i18n с бэкенда (KS-1782).
 *
 * Backend (L-14b / KS-1773) кладёт переводы quiz prompts/options/
 * explanations в `apps/api/src/i18n/<lng>/lessons.json`. Чтобы они
 * доехали до клиента и не дублировались в `apps/web/src/i18n/locales/`,
 * мы пытаемся скачать их с эндпоинта `GET /lessons/i18n/<lng>` (бэкенд
 * выставит его отдельной задачей — вне scope L-15/L-14b).
 *
 * Алгоритм:
 *   1. Дёрнуть эндпоинт.
 *   2. При 200 — `i18n.addResourceBundle(lng, 'translation', json, true, true)`
 *      с deep merge (true, true) — НЕ затирает уже существующие ключи
 *      из `locales/<lng>/translation.json`.
 *   3. При любой ошибке (404 / сеть) — молча пропустить, фронт работает
 *      с тем что уже есть в bundle'е (включая fallback `quizMissingTranslation`).
 *
 * Хук вызывается из `main.tsx` сразу после i18n init. Перезагружается
 * при смене языка через `i18n.on('languageChanged', ...)`.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const loadedLngs = new Set<string>();

export async function loadLessonsResources(lng: string): Promise<void> {
  if (loadedLngs.has(lng)) return;
  loadedLngs.add(lng);
  try {
    const res = await fetch(`${API_URL}/lessons/i18n/${encodeURIComponent(lng)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data === 'object') {
      i18n.addResourceBundle(lng, 'translation', data, true, false);
    }
  } catch {
    // молча игнорим — fallback на bundled-строки
  }
}

/**
 * Подключает обновление при смене языка. Вызывать ОДИН раз после i18n.init().
 */
export function attachLessonsResourceLoader(): void {
  void loadLessonsResources(i18n.language);
  i18n.on('languageChanged', (lng) => {
    void loadLessonsResources(lng);
  });
}
