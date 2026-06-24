// KS-4175: проверка, что компонент действительно вставляет метаданные в
// `<head>` документа. React 19 поднимает теги `<title>`, `<meta>`,
// `<link>`, `<script>` из любого места дерева в head; happy-dom это
// поведение поддерживает. Тестируем:
//   1) обязательные теги (title, description, og:*, twitter:*) ставятся;
//   2) canonical собирается из window.location.pathname, если не передан;
//   3) noindex добавляет meta robots;
//   4) jsonLd сериализуется в <script type="application/ld+json">;
//   5) при перемонтировании с новыми пропсами teги обновляются (singleton).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SeoHelmet } from './SeoHelmet';

function getMetaContent(selector: string): string | null {
  const el = document.head.querySelector(selector);
  return el?.getAttribute('content') ?? null;
}

describe('<SeoHelmet>', () => {
  beforeEach(() => {
    // Чистый head перед каждым тестом — happy-dom сохраняет состояние
    // между тестами в рамках одного файла.
    document.head
      .querySelectorAll('title, meta, link, script[type="application/ld+json"]')
      .forEach((n) => n.remove());
  });

  afterEach(() => {
    cleanup();
  });

  it('ставит title и description', () => {
    render(<SeoHelmet title="Главная" description="Шахматная платформа" />);
    expect(document.title).toBe('Главная');
    expect(getMetaContent('meta[name="description"]')).toBe(
      'Шахматная платформа',
    );
  });

  it('ставит og: и twitter: теги с дефолтами', () => {
    render(<SeoHelmet title="T" description="D" />);
    expect(getMetaContent('meta[property="og:type"]')).toBe('website');
    expect(getMetaContent('meta[property="og:title"]')).toBe('T');
    expect(getMetaContent('meta[property="og:description"]')).toBe('D');
    expect(getMetaContent('meta[property="og:image"]')).toBe('/og/default.png');
    expect(getMetaContent('meta[name="twitter:card"]')).toBe(
      'summary_large_image',
    );
    expect(getMetaContent('meta[name="twitter:image"]')).toBe('/og/default.png');
  });

  it('всегда ставит og:site_name=Kingside и twitter:site=@kingside_chess (KS-4211)', () => {
    render(<SeoHelmet title="T" description="D" />);
    expect(getMetaContent('meta[property="og:site_name"]')).toBe('Kingside');
    expect(getMetaContent('meta[name="twitter:site"]')).toBe('@kingside_chess');
  });

  it('canonical берётся из window.location.pathname, если не передан', () => {
    render(<SeoHelmet title="T" description="D" />);
    const link = document.head.querySelector('link[rel="canonical"]');
    expect(link).not.toBeNull();
    const href = link?.getAttribute('href') ?? '';
    // happy-dom по умолчанию: http://localhost/
    expect(href).toMatch(/^https?:\/\/[^/]+\//);
    expect(href).not.toContain('?');
  });

  it('canonical из пропса перекрывает дефолт', () => {
    render(
      <SeoHelmet
        title="T"
        description="D"
        canonical="https://kingside.site/test"
      />,
    );
    expect(
      document.head
        .querySelector('link[rel="canonical"]')
        ?.getAttribute('href'),
    ).toBe('https://kingside.site/test');
    expect(getMetaContent('meta[property="og:url"]')).toBe(
      'https://kingside.site/test',
    );
  });

  it('noindex по умолчанию даёт `noindex, follow` (KS-4613)', () => {
    render(<SeoHelmet title="T" description="D" noindex />);
    expect(getMetaContent('meta[name="robots"]')).toBe('noindex, follow');
  });

  it('noindex + noindexFollow={false} даёт `noindex, nofollow` (KS-4613)', () => {
    render(<SeoHelmet title="T" description="D" noindex noindexFollow={false} />);
    expect(getMetaContent('meta[name="robots"]')).toBe('noindex, nofollow');
  });

  it('по умолчанию meta robots не ставится', () => {
    render(<SeoHelmet title="T" description="D" />);
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('jsonLd сериализуется в <script type="application/ld+json">', () => {
    const data = { '@context': 'https://schema.org', '@type': 'WebSite' };
    render(<SeoHelmet title="T" description="D" jsonLd={data} />);
    // React 19 поднимает в <head> только скрипты с `src`; inline-скрипт
    // (dangerouslySetInnerHTML) остаётся в месте рендера. Это нормально
    // для SSR/prerender — он попадёт в HTML, бот его прочитает. Ищем по
    // всему документу.
    const script = document.querySelector(
      'script[type="application/ld+json"]',
    );
    expect(script).not.toBeNull();
    expect(JSON.parse(script?.textContent ?? 'null')).toEqual(data);
  });

  it('массив jsonLd сериализуется как массив', () => {
    const data = [{ '@type': 'A' }, { '@type': 'B' }];
    render(<SeoHelmet title="T" description="D" jsonLd={data} />);
    // React 19 поднимает в <head> только скрипты с `src`; inline-скрипт
    // (dangerouslySetInnerHTML) остаётся в месте рендера. Это нормально
    // для SSR/prerender — он попадёт в HTML, бот его прочитает. Ищем по
    // всему документу.
    const script = document.querySelector(
      'script[type="application/ld+json"]',
    );
    expect(JSON.parse(script?.textContent ?? 'null')).toEqual(data);
  });

  it('title длиннее 60 символов обрезается truncateByWord', () => {
    const long =
      'Очень длинный заголовок страницы который точно не помещается в шестьдесят символов';
    render(<SeoHelmet title={long} description="D" />);
    expect(document.title.length).toBeLessThanOrEqual(60);
    expect(document.title.endsWith('…')).toBe(true);
  });

  it('description длиннее 160 символов обрезается truncateByWord', () => {
    const long = 'a '.repeat(120).trim(); // ~239 символов
    render(<SeoHelmet title="T" description={long} />);
    const desc = getMetaContent('meta[name="description"]') ?? '';
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc.endsWith('…')).toBe(true);
  });

  it('hreflang рендерит <link rel="alternate"> на каждый язык (KS-4211)', () => {
    render(
      <SeoHelmet
        title="T"
        description="D"
        hreflang={[
          { lang: 'en', href: 'https://kingside.site/players' },
          { lang: 'ru', href: 'https://kingside.site/ru/players' },
          { lang: 'x-default', href: 'https://kingside.site/players' },
        ]}
      />,
    );
    const links = Array.from(
      document.head.querySelectorAll('link[rel="alternate"]'),
    );
    expect(links).toHaveLength(3);
    const byLang: Record<string, string | null> = {};
    for (const l of links) {
      byLang[l.getAttribute('hreflang') ?? ''] = l.getAttribute('href');
    }
    expect(byLang.en).toBe('https://kingside.site/players');
    expect(byLang.ru).toBe('https://kingside.site/ru/players');
    expect(byLang['x-default']).toBe('https://kingside.site/players');
  });

  it('удаляет статические дубликаты meta из index.html (KS-4211)', () => {
    // Имитируем теги, прилетевшие из `index.html` (статический fallback).
    const staticOgTitle = document.createElement('meta');
    staticOgTitle.setAttribute('property', 'og:title');
    staticOgTitle.setAttribute('content', 'Kingside — Play Chess Online');
    document.head.appendChild(staticOgTitle);

    const staticDescription = document.createElement('meta');
    staticDescription.setAttribute('name', 'description');
    staticDescription.setAttribute('content', 'Default site description');
    document.head.appendChild(staticDescription);

    render(<SeoHelmet title="Per-page" description="Per-page text" />);

    const ogTitles = document.head.querySelectorAll('meta[property="og:title"]');
    expect(ogTitles).toHaveLength(1);
    expect(ogTitles[0].getAttribute('content')).toBe('Per-page');

    const descriptions = document.head.querySelectorAll(
      'meta[name="description"]',
    );
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0].getAttribute('content')).toBe('Per-page text');
  });

  it('по умолчанию <link rel="alternate"> не рендерится', () => {
    render(<SeoHelmet title="T" description="D" />);
    expect(
      document.head.querySelector('link[rel="alternate"]'),
    ).toBeNull();
  });

  it('lang проставляется на documentElement и откатывается на размонтировании', () => {
    const prev = document.documentElement.lang;
    const { unmount } = render(
      <SeoHelmet title="T" description="D" lang="ru" />,
    );
    expect(document.documentElement.lang).toBe('ru');
    unmount();
    expect(document.documentElement.lang).toBe(prev);
  });
});
