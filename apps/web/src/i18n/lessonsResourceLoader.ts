import i18n from 'i18next';

/**
 * Динамический загрузчик lessons-i18n с бэкенда (KS-1782).
 *
 * Backend (L-14b / KS-1773) кладёт переводы курса и quiz prompts/options/
 * explanations в `apps/api/src/i18n/<lng>/lessons.json`. Чтобы они
 * доехали до клиента и не дублировались в `apps/web/src/i18n/locales/`,
 * мы скачиваем их с эндпоинта `GET /lessons/i18n/<lng>`.
 *
 * ## Формат ответа (KS-1806)
 *
 * Бэк отдаёт тело БЕЗ namespace-обёртки `lessons`, т. е. сразу содержимое
 * поддерева — например:
 *
 *   `{ "demo": { "title": "...", "text-demo": { "title": "..." }, ... } }`
 *
 * Компоненты резолвят строки через ключи `lessons.demo.title`,
 * `lessons.demo.text-demo.title`. Если мержить `data` в namespace
 * `translation` как есть, ключи лягут как `translation.demo.*` и
 * `t('lessons.demo.title')` не найдёт перевод — видно как slug в UI
 * и "— перевод временно недоступен —" в QuizStep. Поэтому перед
 * мёржем оборачиваем результат в `{ lessons: data }`. Идемпотентно:
 * если бэк однажды переделают и начнёт возвращать уже обёрнутый
 * `{ lessons: { ... } }`, ветка с проверкой не-удвоит обёртку.
 *
 * ## Поведение
 *   1. Дёрнуть эндпоинт.
 *   2. При 200 — `i18n.addResourceBundle(lng, 'translation', { lessons: data },
 *      true, false)` — deep merge, не перезаписывает существующие bundled-
 *      строки из `locales/<lng>/translation.json`. `react-i18next` слушает
 *      `store.on('added', ...)` и перерисует компоненты автоматически.
 *   3. При любой ошибке (404 / сеть) — молча пропустить, фронт работает
 *      с тем что уже есть в bundle'е (включая fallback `quizMissingTranslation`).
 *
 * Хук вызывается из `main.tsx` сразу после i18n init. Перезагружается
 * при смене языка через `i18n.on('languageChanged', ...)` — каждый язык
 * грузится не чаще одного раза за сессию (кэш `loadedLngs`).
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const loadedLngs = new Set<string>();

/**
 * Вернёт `data` без изменений, если верхний ключ — `lessons`
 * (бэк уже прислал обёртку). Иначе обернёт в `{ lessons: data }`.
 * Экспортируется для тестов.
 */
export function wrapLessonsBundle(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'lessons') {
    return obj;
  }
  return { lessons: obj };
}

/** Сброс кэша загруженных языков — только для тестов. */
export function __resetLoadedLngsForTests(): void {
  loadedLngs.clear();
}

export async function loadLessonsResources(lng: string): Promise<void> {
  if (loadedLngs.has(lng)) return;
  loadedLngs.add(lng);
  try {
    const res = await fetch(`${API_URL}/lessons/i18n/${encodeURIComponent(lng)}`);
    if (!res.ok) return;
    const data = await res.json();
    const bundle = wrapLessonsBundle(data);
    if (!bundle) return;
    i18n.addResourceBundle(lng, 'translation', bundle, true, false);
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
