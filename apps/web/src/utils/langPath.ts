/**
 * KS-4464. Универсальные хелперы для URL'ов, у которых первый сегмент
 * — поддерживаемая локаль (`/<lang>/...`).
 *
 * Сейчас единственный такой раздел — блог (KS-4460: `/<lang>/blog` и
 * `/<lang>/blog/<slug>`). Если в будущем добавятся новые префиксные
 * разделы, нужно лишь расширить множество локалей-префиксов — само
 * переключение языка в шапке (см. `MainLayout.tsx`) уже использует
 * `rewriteLangPrefix` и продолжит работать без правок.
 *
 * Множество локалей-префиксов совпадает с {@link BLOG_LOCALES} — другие
 * URL-префиксы не используются. Если кейс разъедется (например,
 * добавится `/uk/blog`, но `/uk/lessons` не появится), `BLOG_LOCALES`
 * останется источником правды для блога, а здесь заведём отдельный
 * `LANG_PATH_PREFIXES`.
 */
import { BLOG_LOCALES } from './blogUrl';
import type { BlogLocale } from '@kingside/shared';

/**
 * Все локали, которые встречаются как первый сегмент URL.
 * Сейчас совпадает с локалями блога (см. модульный комментарий).
 */
export const LANG_PATH_PREFIXES: readonly BlogLocale[] = BLOG_LOCALES;

/**
 * Тип-гард: строка — поддерживаемый языковой префикс пути.
 */
export function isLangPathPrefix(value: string | undefined): value is BlogLocale {
  return (LANG_PATH_PREFIXES as readonly string[]).includes(value ?? '');
}

/**
 * Возвращает локаль, которой начинается путь (`/en/blog` → `'en'`),
 * либо `null`, если первый сегмент не входит в
 * {@link LANG_PATH_PREFIXES} (например, `/lessons`, `/`).
 */
export function getPathLangPrefix(pathname: string): BlogLocale | null {
  const first = pathname.split('/', 2)[1] ?? '';
  return isLangPathPrefix(first) ? first : null;
}

/**
 * Если `pathname` начинается с поддерживаемого префикса локали —
 * возвращает новый путь с подменённым префиксом. Иначе `null` (вызывающая
 * сторона должна оставить URL как есть — на не-префиксных страницах
 * переключатель языка не трогает URL).
 *
 * Корневой `/<lang>` (без хвоста) тоже поддерживается — превратится в
 * `/<newLang>` (это будущий вариант, сейчас на корневом lang-only пути
 * страниц нет, но поведение корректно).
 *
 * @example
 *   rewriteLangPrefix('/en/blog', 'ru')             // '/ru/blog'
 *   rewriteLangPrefix('/en/blog/critical-moment', 'ru')
 *                                                   // '/ru/blog/critical-moment'
 *   rewriteLangPrefix('/lessons', 'ru')             // null
 *   rewriteLangPrefix('/', 'ru')                    // null
 */
export function rewriteLangPrefix(
  pathname: string,
  newLang: BlogLocale,
): string | null {
  const current = getPathLangPrefix(pathname);
  if (!current) return null;
  // Заменяем ровно первый сегмент. `pathname` начинается со слеша,
  // поэтому `split('/')` даёт `['', '<lang>', ...rest]`.
  const segments = pathname.split('/');
  segments[1] = newLang;
  return segments.join('/');
}
