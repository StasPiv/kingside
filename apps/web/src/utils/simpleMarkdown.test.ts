import { describe, it, expect } from 'vitest';

import { renderMarkdown } from './simpleMarkdown';

/**
 * KS-1987: расширенный markdown-renderer. Базовый набор покрытия:
 * заголовки h1..h6 (исправлен старый mapping `# → h3`), цитаты,
 * нумерованные/маркированные списки, GFM-таблицы, fenced code.
 */

describe('renderMarkdown — headings', () => {
  it('# → h1, ## → h2, …, ###### → h6 (KS-1987)', () => {
    expect(renderMarkdown('# A')).toContain('<h1>A</h1>');
    expect(renderMarkdown('## B')).toContain('<h2>B</h2>');
    expect(renderMarkdown('### C')).toContain('<h3>C</h3>');
    expect(renderMarkdown('#### D')).toContain('<h4>D</h4>');
    expect(renderMarkdown('##### E')).toContain('<h5>E</h5>');
    expect(renderMarkdown('###### F')).toContain('<h6>F</h6>');
  });

  it('####### (7 хешей) — НЕ heading, рендерится как параграф', () => {
    const html = renderMarkdown('####### G');
    expect(html).not.toContain('<h7>');
    expect(html).toContain('<p>');
  });
});

describe('renderMarkdown — lists', () => {
  it('маркированные `-`/`*` → <ul><li>…</li></ul>', () => {
    expect(renderMarkdown('- one\n- two')).toBe(
      '<ul><li>one</li><li>two</li></ul>',
    );
    expect(renderMarkdown('* a\n* b')).toBe(
      '<ul><li>a</li><li>b</li></ul>',
    );
  });

  it('нумерованные `1. … 2. …` → <ol><li>…</li></ol>', () => {
    expect(renderMarkdown('1. one\n2. two')).toBe(
      '<ol><li>one</li><li>two</li></ol>',
    );
  });

  it('переход с ul на ol закрывает предыдущий список', () => {
    const html = renderMarkdown('- a\n1. b');
    expect(html).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });
});

describe('renderMarkdown — blockquotes', () => {
  it('`> text` → <blockquote><p>text</p></blockquote>', () => {
    expect(renderMarkdown('> Quote')).toBe(
      '<blockquote><p>Quote</p></blockquote>',
    );
  });

  it('многострочная цитата склеивается через <br/>', () => {
    expect(renderMarkdown('> line1\n> line2')).toBe(
      '<blockquote><p>line1<br/>line2</p></blockquote>',
    );
  });

  it('пустая строка прерывает цитату', () => {
    expect(renderMarkdown('> q\n\nP')).toBe(
      '<blockquote><p>q</p></blockquote><p>P</p>',
    );
  });
});

describe('renderMarkdown — tables (GFM)', () => {
  it('header + separator + rows → <table>', () => {
    const md = ['| H1 | H2 |', '| --- | --- |', '| a | b |', '| c | d |'].join(
      '\n',
    );
    const html = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead><tr><th>H1</th><th>H2</th></tr></thead>');
    expect(html).toContain('<tr><td>a</td><td>b</td></tr>');
    expect(html).toContain('<tr><td>c</td><td>d</td></tr>');
  });

  it('таблица без боковых пайпов работает', () => {
    const md = ['H1 | H2', '--- | ---', 'a | b'].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<th>H1</th><th>H2</th>');
    expect(html).toContain('<td>a</td><td>b</td>');
  });
});

describe('renderMarkdown — code & inline', () => {
  it('fenced code сохраняет содержимое и экранирует HTML', () => {
    const html = renderMarkdown('```\n<x>\n```');
    expect(html).toBe('<pre><code>&lt;x&gt;</code></pre>');
  });

  it('**bold** / *italic* / `code` inline', () => {
    expect(renderMarkdown('**a** *b* `c`')).toContain(
      '<strong>a</strong> <em>b</em> <code>c</code>',
    );
  });
});
