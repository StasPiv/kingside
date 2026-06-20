/**
 * KS-4394 / ADR-137 T2 §2.3. Разрешение локали статьи.
 *
 * Каждая статья имеет slug-«семью» — пары `<slug>.ru.md` и/или
 * `<slug>.en.md`. Перевод одной локали может отсутствовать (ADR-137
 * §2.3: «можно публиковать только RU или только EN»). UI-страница
 * `/blog` показывает по одной карточке на slug, а не по две (по числу
 * локалей) — иначе при наличии обоих переводов лента дублировалась бы.
 *
 * `filterByLocale`:
 *   - возвращает массив с одной записью на slug;
 *   - если есть запись в нужной локали — используется она;
 *   - иначе (при `allowFallback = true`, дефолт) — используется
 *     доступный перевод, чтобы статья не пропадала из ленты;
 *   - если `allowFallback = false` — slug'и без нужной локали
 *     отсеиваются.
 *
 * Возвращаемые элементы аннотированы флагом `isLocaleFallback` — UI
 * рисует на них плашку «эта статья пока не переведена».
 */
import type { BlogIndexEntry, BlogLocale } from '../../types/blog';

export interface BlogListEntry extends BlogIndexEntry {
  /** `true` — для slug не нашлось записи в запрошенной локали. */
  isLocaleFallback: boolean;
}

export interface FilterByLocaleOptions {
  /**
   * Если у slug нет записи в `locale` — взять любую другую доступную
   * локаль. По умолчанию `true`.
   */
  allowFallback?: boolean;
}

export function filterByLocale(
  entries: readonly BlogIndexEntry[],
  locale: BlogLocale,
  opts: FilterByLocaleOptions = {},
): BlogListEntry[] {
  const allowFallback = opts.allowFallback ?? true;
  // Сохраняем порядок появления slug'а: первая запись slug'а в `entries`
  // задаёт позицию в результате (важно для сортировки по publishedAt
  // DESC, которую делает индекс при сборке).
  const order: string[] = [];
  const bySlug = new Map<
    string,
    Partial<Record<BlogLocale, BlogIndexEntry>>
  >();
  for (const e of entries) {
    if (!bySlug.has(e.slug)) {
      bySlug.set(e.slug, {});
      order.push(e.slug);
    }
    const bucket = bySlug.get(e.slug)!;
    if (!bucket[e.locale]) bucket[e.locale] = e;
  }

  const out: BlogListEntry[] = [];
  for (const slug of order) {
    const bucket = bySlug.get(slug)!;
    const exact = bucket[locale];
    if (exact) {
      out.push({ ...exact, isLocaleFallback: false });
      continue;
    }
    if (!allowFallback) continue;
    // Берём первый доступный перевод (порядок BLOG_LOCALES не важен —
    // в bucket'е всё, что есть).
    const fallback = Object.values(bucket).find(Boolean);
    if (fallback) {
      out.push({ ...fallback, isLocaleFallback: true });
    }
  }
  return out;
}
