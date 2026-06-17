/**
 * KS-4209 / ADR-128 §7.10 §10 #15. Чистые builder'ы XML sitemap'ов
 * для поисковой индексации публичных страниц kingside.site.
 *
 * Не дёргает БД и не имеет состояния: принимает уже выбранные строки
 * (или статические маршруты) и возвращает строку с валидным XML.
 * Сами выборки делает `SitemapService` через PrismaService — это
 * разделяет «как делать XML» (тестируется чисто) и «откуда брать
 * данные» (зависит от моделей и фильтров).
 *
 * Формат соответствует спецификации https://www.sitemaps.org/protocol.html:
 *   - `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
 *   - элементы `<url>` с `<loc>`, опционально `<lastmod>`,
 *     `<changefreq>`, `<priority>`.
 *   - sitemap-index — `<sitemapindex>` с `<sitemap>` элементами,
 *     каждый с `<loc>` и `<lastmod>`.
 *
 * Лимит 50 000 URL на один файл (требование протокола) проверяется
 * builder'ом — если превышено, выбрасывается ошибка (caller обязан
 * разбить набор; для текущих объёмов kingside.site лимит достигнут не
 * будет, но защита от регрессии в будущем).
 */

/** Спец-лимит протокола sitemaps.org. */
export const SITEMAP_MAX_URLS = 50_000;

export type ChangeFreq =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

export interface SitemapUrlEntry {
  /** Полный абсолютный URL — `<loc>`. */
  loc: string;
  /** ISO-8601 дата последней модификации — `<lastmod>`. */
  lastmod?: string | Date | null;
  /** Подсказка частоты обновления. */
  changefreq?: ChangeFreq;
  /** 0.0–1.0; default 0.5. */
  priority?: number;
}

export interface SitemapIndexEntry {
  /** Полный абсолютный URL дочернего sitemap'а. */
  loc: string;
  /** Дата последней генерации этого дочернего sitemap'а. */
  lastmod?: string | Date | null;
}

/**
 * Сериализовать `Date` или ISO-строку в `YYYY-MM-DD`. Google
 * принимает оба формата (full ISO datetime тоже), но дата без времени
 * читабельнее и достаточна по протоколу.
 */
function isoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

/**
 * Экранировать спецсимволы XML в `<loc>`. Sitemap.org требует
 * `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`,
 * `'` → `&apos;` в значениях `<loc>`.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Собрать `<urlset>`-документ. Опускает все пустые поля.
 */
export function buildUrlset(entries: SitemapUrlEntry[]): string {
  if (entries.length > SITEMAP_MAX_URLS) {
    throw new Error(
      `Sitemap urlset exceeds ${SITEMAP_MAX_URLS} entries (got ${entries.length}); split into multiple files`,
    );
  }
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    const lm = isoDate(entry.lastmod);
    if (lm) lines.push(`    <lastmod>${lm}</lastmod>`);
    if (entry.changefreq) {
      lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    }
    if (entry.priority !== undefined) {
      const p = Math.max(0, Math.min(1, entry.priority)).toFixed(1);
      lines.push(`    <priority>${p}</priority>`);
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  // Trailing newline — конвенция большинства линтеров/CDN.
  return `${lines.join('\n')}\n`;
}

/**
 * Собрать `<sitemapindex>`-документ для корневого `sitemap.xml`.
 */
export function buildSitemapIndex(entries: SitemapIndexEntry[]): string {
  if (entries.length > SITEMAP_MAX_URLS) {
    throw new Error(
      `Sitemap index exceeds ${SITEMAP_MAX_URLS} entries (got ${entries.length})`,
    );
  }
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of entries) {
    lines.push('  <sitemap>');
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    const lm = isoDate(entry.lastmod);
    if (lm) lines.push(`    <lastmod>${lm}</lastmod>`);
    lines.push('  </sitemap>');
  }
  lines.push('</sitemapindex>');
  return `${lines.join('\n')}\n`;
}

/**
 * Статические публичные маршруты kingside.site. Источник правды:
 * §7.10 — 15-20 PM/PR-лендингов. Поддерживается вручную при
 * добавлении новых публичных страниц.
 *
 * `priority` — относительная важность; для главной 1.0, для
 * вспомогательных лендингов 0.5–0.7.
 */
export const STATIC_PUBLIC_ROUTES: ReadonlyArray<
  Pick<SitemapUrlEntry, 'loc' | 'changefreq' | 'priority'>
> = [
  { loc: '/', changefreq: 'daily', priority: 1.0 },
  { loc: '/lectures', changefreq: 'daily', priority: 0.8 },
  { loc: '/broadcasts', changefreq: 'hourly', priority: 0.8 },
  { loc: '/tournaments', changefreq: 'daily', priority: 0.8 },
  { loc: '/players', changefreq: 'daily', priority: 0.6 },
  { loc: '/archive', changefreq: 'weekly', priority: 0.5 },
  { loc: '/about', changefreq: 'monthly', priority: 0.4 },
  // KS-4326 / KS-4325. Публичные SEO-лендинги: «Анализ PGN онлайн» и
  // «Задачи из ваших партий». Карточки сделаны фронтом, страницы
  // существуют на kingside.site и должны индексироваться.
  { loc: '/analyze-pgn-online', changefreq: 'monthly', priority: 0.8 },
  { loc: '/puzzles-from-your-games', changefreq: 'monthly', priority: 0.8 },
  { loc: '/login', changefreq: 'yearly', priority: 0.3 },
  { loc: '/register', changefreq: 'yearly', priority: 0.3 },
];

/**
 * Собрать `<urlset>` для статических маршрутов. Возвращает XML с
 * полными URL'ами (с `baseUrl` префиксом). `lastmod` для статики не
 * задаём — Google трактует отсутствие как «обновлений нет».
 */
export function buildStaticSitemap(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return buildUrlset(
    STATIC_PUBLIC_ROUTES.map((r) => ({
      loc: `${base}${r.loc}`,
      changefreq: r.changefreq,
      priority: r.priority,
    })),
  );
}
