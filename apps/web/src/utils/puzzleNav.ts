/**
 * KS-2688. Хелперы навигации для `/puzzle/:id` — определяют раздел,
 * из которого юзер пришёл на страницу пазла, и собирают URL возврата
 * с сохранением исходных query-параметров (mine/visibility/...).
 *
 * Контекст: после решения пазла на `PuzzlePage` юзер должен попадать
 * туда, откуда пришёл — `/precision` (Тренировка точности) или
 * `/puzzles` (общие задачи). До KS-2688 везде стояла хардкод-ссылка
 * `/puzzles`, что уводило юзера со draft-фильтра precision на чужой
 * раздел (жалоба пользователя в Telegram, 2026-05-10).
 *
 * Маркер раздела — query-параметр `?source=precision` (KS-2547,
 * ADR-048 §5). Старое значение `'play-vs-engine'` тоже принимается
 * (см. `precisionSource.ts`).
 *
 * Сохраняемые query-параметры (precision):
 *  - `mine=true`         — фильтр «мои пазлы».
 *  - `visibility=draft|public|all` — фильтр черновиков (KS-2586).
 *
 * Все хелперы pure — без React/Router зависимостей. Используют
 * стандартный `URLSearchParams`. Тестируются отдельно.
 */

export type PuzzleSection = 'precision' | 'puzzles';

const PRECISION_SOURCE_VALUES = new Set(['precision', 'play-vs-engine']);

/** Список query-параметров `/precision`, которые сохраняем при возврате. */
const PRECISION_PRESERVED_PARAMS = ['mine', 'visibility'] as const;

/**
 * Определить раздел, из которого юзер пришёл на пазл, по query-параметрам
 * текущей страницы пазла. Если `source` — precision-вариант, возвращаем
 * `'precision'`. Иначе fallback на `'puzzles'` (общий раздел задач).
 */
export function detectPuzzleSection(
  searchParams: URLSearchParams,
): PuzzleSection {
  const source = searchParams.get('source');
  if (source && PRECISION_SOURCE_VALUES.has(source)) return 'precision';
  return 'puzzles';
}

/**
 * Собрать URL возврата (относительный путь) для текущего раздела,
 * сохраняя precision-фильтры (mine/visibility), если они были переданы
 * через query текущей страницы пазла.
 *
 * Примеры:
 *  - `?source=precision&mine=true&visibility=draft` →
 *    `/precision?mine=true&visibility=draft`
 *  - `?source=precision`               → `/precision`
 *  - (нет source)                      → `/puzzles`
 */
export function buildBackUrl(searchParams: URLSearchParams): string {
  const section = detectPuzzleSection(searchParams);
  if (section === 'puzzles') return '/puzzles';
  const sp = new URLSearchParams();
  for (const key of PRECISION_PRESERVED_PARAMS) {
    const value = searchParams.get(key);
    if (value) sp.set(key, value);
  }
  const qs = sp.toString();
  return qs ? `/precision?${qs}` : '/precision';
}

/**
 * Собрать query-string для перехода на `/puzzle/:id` из раздела precision
 * с сохранением `mine`/`visibility` (для возврата). Возвращает строку
 * вида `?source=precision&mine=true&visibility=draft` (с лидирующим `?`)
 * или `?source=precision` если фильтров нет.
 *
 * Используется в PrecisionPage при клике по карточке.
 */
export function buildPrecisionPuzzleQuery(
  precisionSearchParams: URLSearchParams,
): string {
  const sp = new URLSearchParams();
  sp.set('source', 'precision');
  for (const key of PRECISION_PRESERVED_PARAMS) {
    const value = precisionSearchParams.get(key);
    if (value) sp.set(key, value);
  }
  return `?${sp.toString()}`;
}
