/**
 * KS-4209. Unit-тесты чистых XML-builder'ов sitemap.
 */
import {
  buildSitemapIndex,
  buildStaticSitemap,
  buildUrlset,
  escapeXml,
  SITEMAP_MAX_URLS,
  STATIC_PUBLIC_ROUTES,
} from './sitemap-builder';

describe('escapeXml', () => {
  it('экранирует & < > " \' в URL', () => {
    expect(escapeXml('a&b<c>d"e\'f')).toBe(
      'a&amp;b&lt;c&gt;d&quot;e&apos;f',
    );
  });
  it('не трогает обычные символы', () => {
    expect(escapeXml('https://kingside.site/players/alice')).toBe(
      'https://kingside.site/players/alice',
    );
  });
});

describe('buildUrlset', () => {
  it('пустой urlset → валидный XML', () => {
    const xml = buildUrlset([]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain('</urlset>');
    // Никаких <url>.
    expect(xml).not.toContain('<url>');
  });

  it('одна запись с всеми полями', () => {
    const xml = buildUrlset([
      {
        loc: 'https://kingside.site/lectures/lec-1',
        lastmod: new Date('2026-06-15T12:34:56Z'),
        changefreq: 'daily',
        priority: 0.7,
      },
    ]);
    expect(xml).toContain('<loc>https://kingside.site/lectures/lec-1</loc>');
    expect(xml).toContain('<lastmod>2026-06-15</lastmod>');
    expect(xml).toContain('<changefreq>daily</changefreq>');
    expect(xml).toContain('<priority>0.7</priority>');
  });

  it('lastmod как ISO-строка тоже работает', () => {
    const xml = buildUrlset([
      { loc: 'https://x', lastmod: '2026-06-15T00:00:00Z' },
    ]);
    expect(xml).toContain('<lastmod>2026-06-15</lastmod>');
  });

  it('lastmod=null опускается', () => {
    const xml = buildUrlset([{ loc: 'https://x', lastmod: null }]);
    expect(xml).not.toContain('<lastmod>');
  });

  it('lastmod=undefined опускается', () => {
    const xml = buildUrlset([{ loc: 'https://x' }]);
    expect(xml).not.toContain('<lastmod>');
  });

  it('priority clamp на 0..1', () => {
    const xml = buildUrlset([
      { loc: 'https://x', priority: 1.7 },
      { loc: 'https://y', priority: -2 },
    ]);
    expect(xml).toContain('<priority>1.0</priority>');
    expect(xml).toContain('<priority>0.0</priority>');
  });

  it('экранирует & в URL', () => {
    const xml = buildUrlset([
      { loc: 'https://x.test/a?b=1&c=2' },
    ]);
    expect(xml).toContain('<loc>https://x.test/a?b=1&amp;c=2</loc>');
  });

  it('бросает при превышении SITEMAP_MAX_URLS', () => {
    const tooMany: { loc: string }[] = Array.from(
      { length: SITEMAP_MAX_URLS + 1 },
      (_, i) => ({ loc: `https://x/${i}` }),
    );
    expect(() => buildUrlset(tooMany)).toThrow(/exceeds 50000/);
  });

  it('ровно SITEMAP_MAX_URLS — ok', () => {
    const exact: { loc: string }[] = Array.from(
      { length: SITEMAP_MAX_URLS },
      (_, i) => ({ loc: `https://x/${i}` }),
    );
    expect(() => buildUrlset(exact)).not.toThrow();
  });

  it('заканчивается trailing newline', () => {
    const xml = buildUrlset([{ loc: 'https://x' }]);
    expect(xml.endsWith('\n')).toBe(true);
  });

  // KS-4462: hreflang alternates.
  it('без alternates → корневой <urlset> БЕЗ xmlns:xhtml', () => {
    const xml = buildUrlset([{ loc: 'https://x' }]);
    expect(xml).not.toContain('xmlns:xhtml');
    expect(xml).not.toContain('<xhtml:link');
  });

  it('хотя бы одна запись с alternates → корневой <urlset> с xmlns:xhtml', () => {
    const xml = buildUrlset([
      {
        loc: 'https://kingside.site/en/blog/hello',
        alternates: [
          { hreflang: 'en', href: 'https://kingside.site/en/blog/hello' },
          { hreflang: 'ru', href: 'https://kingside.site/ru/blog/hello' },
          { hreflang: 'x-default', href: 'https://kingside.site/en/blog/hello' },
        ],
      },
    ]);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    );
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="en" href="https://kingside.site/en/blog/hello"/>',
    );
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="ru" href="https://kingside.site/ru/blog/hello"/>',
    );
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://kingside.site/en/blog/hello"/>',
    );
  });

  it('пустой массив alternates → ведёт себя как без alternates', () => {
    const xml = buildUrlset([{ loc: 'https://x', alternates: [] }]);
    expect(xml).not.toContain('xmlns:xhtml');
    expect(xml).not.toContain('<xhtml:link');
  });

  it('экранирует href и hreflang в alternates', () => {
    const xml = buildUrlset([
      {
        loc: 'https://x',
        alternates: [{ hreflang: 'en', href: 'https://x?a=1&b=2' }],
      },
    ]);
    expect(xml).toContain('href="https://x?a=1&amp;b=2"');
  });
});

describe('buildSitemapIndex', () => {
  it('пустой index → валидный XML', () => {
    const xml = buildSitemapIndex([]);
    expect(xml).toContain(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain('</sitemapindex>');
    expect(xml).not.toContain('<sitemap>');
  });

  it('записи с lastmod', () => {
    const xml = buildSitemapIndex([
      {
        loc: 'https://kingside.site/sitemap-broadcasts.xml',
        lastmod: new Date('2026-06-15T00:00:00Z'),
      },
      {
        loc: 'https://kingside.site/sitemap-lectures.xml',
        lastmod: new Date('2026-06-14T00:00:00Z'),
      },
    ]);
    expect(xml).toContain(
      '<loc>https://kingside.site/sitemap-broadcasts.xml</loc>',
    );
    expect(xml).toContain('<lastmod>2026-06-15</lastmod>');
    expect(xml).toContain(
      '<loc>https://kingside.site/sitemap-lectures.xml</loc>',
    );
    expect(xml).toContain('<lastmod>2026-06-14</lastmod>');
  });
});

describe('buildStaticSitemap', () => {
  it('собирает все STATIC_PUBLIC_ROUTES с абсолютными URL', () => {
    const xml = buildStaticSitemap('https://kingside.site');
    for (const route of STATIC_PUBLIC_ROUTES) {
      expect(xml).toContain(
        `<loc>https://kingside.site${route.loc}</loc>`,
      );
    }
  });

  it('убирает trailing slash у baseUrl', () => {
    const xml = buildStaticSitemap('https://kingside.site//');
    // Не должно быть `https://kingside.site/${'//'}/...`
    expect(xml).toContain('<loc>https://kingside.site/</loc>');
    expect(xml).not.toContain('https://kingside.site//');
  });

  it('главная страница имеет priority=1.0 и changefreq=daily', () => {
    const xml = buildStaticSitemap('https://kingside.site');
    // Главная — первая в STATIC_PUBLIC_ROUTES.
    const homeBlock = xml.split('<url>')[1].split('</url>')[0];
    expect(homeBlock).toContain('<priority>1.0</priority>');
    expect(homeBlock).toContain('<changefreq>daily</changefreq>');
  });
});
