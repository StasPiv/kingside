import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { DocsMarkdown, slugify } from './docsMarkdown';

/**
 * KS-1895: minimal-coverage юнит-тесты на собственный markdown-рендерер
 * для документации. Цель — гарантировать что ключевые конструкции из
 * `docs/features/user-courses.md` (заголовки, таблицы, списки,
 * картинки, code-блоки, blockquote, якорные ссылки) рендерятся в
 * правильный DOM.
 */

describe('slugify', () => {
  it('русские заголовки → kebab-case slug', () => {
    expect(slugify('1. Обзор раздела')).toBe('1-обзор-раздела');
  });
  it('убирает спец-символы и backticks', () => {
    expect(slugify('Поле `bodyMarkdown`!')).toBe('поле-bodymarkdown');
  });
  it('латиница тоже работает', () => {
    expect(slugify('Setup для воспроизведения')).toBe('setup-для-воспроизведения');
  });
});

describe('<DocsMarkdown> headings + anchors', () => {
  it('генерит h1..h4 с id-якорями', () => {
    const { container } = render(
      <DocsMarkdown
        source={[
          '# Заголовок документа',
          '',
          '## 1. Обзор раздела',
          '',
          '### Подзаголовок',
        ].join('\n')}
      />,
    );
    expect(container.querySelector('h1')?.id).toBe('заголовок-документа');
    expect(container.querySelector('h2')?.id).toBe('1-обзор-раздела');
    expect(container.querySelector('h3')?.id).toBe('подзаголовок');
  });

  it('onHeading callback вызывается на каждый заголовок', () => {
    const headings: Array<[number, string, string]> = [];
    render(
      <DocsMarkdown
        source={'# A\n\n## B\n\n### C'}
        onHeading={(level, text, id) => headings.push([level, text, id])}
      />,
    );
    expect(headings).toEqual([
      [1, 'A', 'a'],
      [2, 'B', 'b'],
      [3, 'C', 'c'],
    ]);
  });
});

describe('<DocsMarkdown> inline', () => {
  it('**bold**, *italic*, `code` — рендерятся в strong/em/code', () => {
    const { container } = render(
      <DocsMarkdown source={'**жирно**, *курсив*, `inline`.'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('жирно');
    expect(container.querySelector('em')?.textContent).toBe('курсив');
    expect(container.querySelector('code')?.textContent).toBe('inline');
  });

  it('якорные ссылки [label](#id) → <a href="#id">', () => {
    const { container } = render(
      <DocsMarkdown source={'[раздел 7](#7-известные-ограничения)'} />,
    );
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('#7-известные-ограничения');
    expect(a?.getAttribute('target')).toBeNull(); // внутренний — не _blank
  });

  it('внешние ссылки получают target=_blank rel=noopener', () => {
    const { container } = render(
      <DocsMarkdown source={'[google](https://google.com)'} />,
    );
    const a = container.querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });
});

describe('<DocsMarkdown> images', () => {
  it('![alt](./screenshots/x.png) → <img src=baseUrl+screenshots/...>', () => {
    const { container } = render(
      <DocsMarkdown
        source={'![Скрин](./screenshots/lessons-list-author.png)'}
        baseUrl="/docs/user-courses/"
      />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      '/docs/user-courses/screenshots/lessons-list-author.png',
    );
    expect(img?.getAttribute('alt')).toBe('Скрин');
  });

  it('одиночная картинка-параграф рендерится как <figure> с figcaption', () => {
    const { container } = render(
      <DocsMarkdown
        source={'![Подпись](./pic.png)'}
        baseUrl="/docs/x/"
      />,
    );
    expect(container.querySelector('figure')).not.toBeNull();
    expect(container.querySelector('figcaption')?.textContent).toBe('Подпись');
  });
});

describe('<DocsMarkdown> tables', () => {
  it('GFM-таблица → <table> с thead/tbody', () => {
    const { container } = render(
      <DocsMarkdown
        source={[
          '| Роль | Видит |',
          '|---|---|',
          '| Гость | системные |',
          '| **Студент** | системные + мои |',
        ].join('\n')}
      />,
    );
    const ths = container.querySelectorAll('th');
    expect(ths).toHaveLength(2);
    expect(ths[0].textContent).toBe('Роль');
    expect(ths[1].textContent).toBe('Видит');
    const trs = container.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(2);
    expect(trs[1].querySelector('strong')?.textContent).toBe('Студент');
  });
});

describe('<DocsMarkdown> blocks', () => {
  it('fenced ``` → <pre><code>', () => {
    const { container } = render(
      <DocsMarkdown source={'```\nconst x = 1;\n```'} />,
    );
    expect(container.querySelector('pre code')?.textContent).toBe(
      'const x = 1;',
    );
  });

  it('blockquote `>` → <blockquote>', () => {
    const { container } = render(
      <DocsMarkdown source={'> Важное\n> примечание.'} />,
    );
    expect(container.querySelector('blockquote')?.textContent).toContain(
      'Важное',
    );
  });

  it('bullet list с вложенностью → <ul> с вложенным <ul>', () => {
    const { container } = render(
      <DocsMarkdown
        source={['- Раз', '- Два', '  - Подпункт', '- Три'].join('\n')}
      />,
    );
    const topUl = container.querySelector('ul');
    expect(topUl).not.toBeNull();
    expect(topUl!.querySelectorAll(':scope > li')).toHaveLength(3);
    expect(topUl!.querySelector('li ul')).not.toBeNull();
  });

  it('numbered list (1. ...) → <ol>', () => {
    const { container } = render(
      <DocsMarkdown source={'1. Первый\n2. Второй'} />,
    );
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('--- → <hr>', () => {
    const { container } = render(
      <DocsMarkdown source={'Текст\n\n---\n\nЕщё'} />,
    );
    expect(container.querySelector('hr')).not.toBeNull();
  });
});
