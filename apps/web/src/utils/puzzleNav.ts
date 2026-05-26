/**
 * KS-2688 / KS-3349. Хелперы навигации для `/puzzle/:id` — определяют
 * раздел, из которого юзер пришёл на страницу пазла, и собирают URL
 * возврата с сохранением исходных query-параметров.
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
 *  - `mine=true`         — legacy фильтр «мои пазлы» (KS-2586).
 *  - `visibility=draft|public|all` — legacy фильтр черновиков (KS-2586).
 *  - `scope=server|drafts|published` — новая схема KS-3347 (ADR-079 §2.6).
 *  - `objective=convertAdvantage|saveEquality` — segment «Тип» (KS-3147).
 *  - `blundererEloMin/Max` — фильтр по рейтингу игроков (KS-2758/2763).
 *  - `showSolved=true` — показывать удержанные позиции (KS-2754).
 *
 * Все хелперы pure — без React/Router зависимостей. Используют
 * стандартный `URLSearchParams`. Тестируются отдельно.
 */
import type { PickNextPrecisionRequest, PrecisionScope } from '@kingside/shared';

export type PuzzleSection = 'precision' | 'puzzles';

const PRECISION_SOURCE_VALUES = new Set(['precision', 'play-vs-engine']);

/**
 * Список query-параметров `/precision`, которые сохраняем при переходе
 * на `/puzzle/:id` и возврате. KS-3349: добавлены `scope`, `objective`,
 * `blundererEloMin/Max`, `showSolved` — нужны для «Следующая» (call
 * `/precision/next` с теми же фильтрами).
 */
const PRECISION_PRESERVED_PARAMS = [
  'mine',
  'visibility',
  'scope',
  'objective',
  'blundererEloMin',
  'blundererEloMax',
  'showSolved',
] as const;

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

/**
 * KS-3349 (ADR-079 §3.4). Собрать `PickNextPrecisionRequest` из текущих
 * query-параметров страницы пазла (`/puzzle/:id?source=precision&…`).
 * Используется кнопкой «Следующая», чтобы передать в `/precision/next`
 * те же фильтры, что были на `/precision` при заходе на пазл.
 *
 * Маппинг:
 *  - `scope` → берётся напрямую (server/drafts/published). Backward-compat:
 *    если `scope` нет, но есть legacy `?mine=true`, выводим scope из
 *    mine/visibility (та же логика что в `readPrecisionScope`).
 *  - `objective` → `convertAdvantage|saveEquality|undefined` (если 'all'
 *    или отсутствует — не передаём, бэкенд default 'all').
 *  - `overrideRatingMin/Max` → только когда оба заданы и валидны.
 *  - `hideSolved` → `true` когда `showSolved` НЕ установлен (см. KS-2754
 *    инверсия). При гостях параметр не передаём.
 *
 * Гостям доступен только `scope=server` (даже если URL содержит другое).
 */
export function buildPrecisionNextParams(
  searchParams: URLSearchParams,
  isAuthenticated: boolean,
): PickNextPrecisionRequest {
  let scope: PrecisionScope;
  const rawScope = searchParams.get('scope');
  if (
    isAuthenticated &&
    (rawScope === 'server' || rawScope === 'drafts' || rawScope === 'published')
  ) {
    scope = rawScope;
  } else if (isAuthenticated && searchParams.get('mine') === 'true') {
    scope =
      searchParams.get('visibility') === 'public' ? 'published' : 'drafts';
  } else {
    scope = 'server';
  }

  const result: PickNextPrecisionRequest = { scope };

  const objective = searchParams.get('objective');
  if (objective === 'convertAdvantage' || objective === 'saveEquality') {
    result.objective = objective;
  }

  const minRaw = searchParams.get('blundererEloMin');
  const maxRaw = searchParams.get('blundererEloMax');
  if (minRaw && /^\d+$/.test(minRaw)) {
    result.overrideRatingMin = Number(minRaw);
  }
  if (maxRaw && /^\d+$/.test(maxRaw)) {
    result.overrideRatingMax = Number(maxRaw);
  }

  // hideSolved — auth-only. Backend default = false (показывает всё).
  // Фронт по KS-2754 инвертирует: показываем НЕрешённые по дефолту →
  // `hideSolved=true` когда checkbox `showSolved` НЕ установлен.
  if (isAuthenticated) {
    const showSolved = searchParams.get('showSolved') === 'true';
    if (!showSolved) result.hideSolved = true;
  }

  return result;
}
