/**
 * KS-4236 / ADR-128 §7.10. Чистые builder'ы XML sitemap'ов для
 * `broadcast-service` — генератор `sitemap-broadcasts.xml`.
 *
 * Дубликат `apps/api/src/sitemap/sitemap-builder.ts` (KS-4209), скопирован
 * чтобы не вводить новый общий пакет ради ~80 строк. Контракт совпадает
 * один-в-один: при изменении формата протокола обновлять оба места.
 *
 * Формат соответствует https://www.sitemaps.org/protocol.html.
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
  loc: string;
  lastmod?: string | Date | null;
  changefreq?: ChangeFreq;
  priority?: number;
}

function isoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
  return `${lines.join('\n')}\n`;
}
