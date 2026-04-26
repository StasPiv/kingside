/**
 * Simple markdown renderer — no external dependencies.
 *
 * Поддерживает:
 *  - заголовки `#`..`######` (h1..h6),
 *  - параграфы,
 *  - **bold** / *italic* / `code`,
 *  - ```fenced code blocks```,
 *  - маркированные списки (`-`, `*`),
 *  - нумерованные списки (`1.`, `2.`, ...),
 *  - цитаты (`> `),
 *  - GFM-таблицы (с разделителем `| --- | --- |`),
 *  - ссылки `[label](url)` + автолинки `https://…` и относительные `/…`.
 *
 * Намеренно не используется внешний markdown-движок: проект не имеет
 * доступа к `npm install` через FE-агентский MCP, добавление полноценного
 * `react-markdown` ушло бы в следующую инфра-задачу. До этого момента
 * расширяем встроенный рендерер до уровня, нужного пилотным курсам
 * (KS-1987 — h4-заголовки + цитаты + таблицы).
 *
 * Ограничения (что НЕ реализовано):
 *  - вложенные списки — превращаются в плоские (отступы съедаются `trim`),
 *  - inline-HTML — экранируется как текст,
 *  - markdown-картинки `![]()` — не парсятся (диаграммы в TextStep
 *    встроены через `{{diagram:N}}` и обрабатываются до этого этапа).
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const INTERNAL_HOSTS = [window.location.host, 'kingside.site', 'www.kingside.site', 'chess-analyze.online'];

function isInternal(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin);
    return INTERNAL_HOSTS.includes(u.host);
  } catch {
    return url.startsWith('/');
  }
}

function makeLink(url: string, label: string): string {
  if (isInternal(url)) {
    const path = url.startsWith('/') ? url : new URL(url).pathname + new URL(url).search;
    return `<a href="${path}" data-internal="true">${label}</a>`;
  }
  return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => makeLink(url, label))
    .replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, (_, pre, url) => pre + makeLink(url, url))
    .replace(/(^|[\s(])(?:&lt;)?(\/[a-zA-Z][a-zA-Z0-9/_-]*(?:\?[^\s<]*)?)(?:&gt;)?(?=[\s),.]|$)/g, (_, pre, path) => pre + makeLink(path, path));
}

type ListType = 'ul' | 'ol';

interface ListState {
  type: ListType;
  open: boolean;
}

/** Ровно один из `ul`/`ol` либо никакого. Закрывает текущий, если другой тип. */
function ensureList(html: string[], state: ListState, type: ListType): void {
  if (state.open && state.type !== type) {
    html.push(`</${state.type}>`);
    state.open = false;
  }
  if (!state.open) {
    html.push(`<${type}>`);
    state.type = type;
    state.open = true;
  }
}

function closeList(html: string[], state: ListState): void {
  if (state.open) {
    html.push(`</${state.type}>`);
    state.open = false;
  }
}

interface QuoteState {
  open: boolean;
  buf: string[];
}

function flushQuote(html: string[], q: QuoteState): void {
  if (!q.open) return;
  // Внутри цитаты применяем тот же inline-рендер; параграфы внутри
  // разделены пустой строкой — для простоты склеиваем в один <p>.
  const inner = q.buf.map((l) => renderInline(l)).join('<br/>');
  html.push(`<blockquote><p>${inner}</p></blockquote>`);
  q.buf = [];
  q.open = false;
}

/**
 * GFM-таблица: первая строка — заголовки, вторая — разделитель из `---`
 * (с возможным выравниванием `:---:`), далее — строки данных. Пайп `|`
 * по краям опционален.
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed) return false;
  return trimmed
    .split('|')
    .every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  const list: ListState = { type: 'ul', open: false };
  const quote: QuoteState = { open: false, buf: [] };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        closeList(html, list);
        flushQuote(html, quote);
        inCodeBlock = true;
      }
      i += 1;
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      i += 1;
      continue;
    }

    const trimmed = line.trim();

    // Пустая строка — закрываем все открытые блоки.
    if (!trimmed) {
      closeList(html, list);
      flushQuote(html, quote);
      i += 1;
      continue;
    }

    // GFM-таблица: ищем заголовок + сепаратор.
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      closeList(html, list);
      flushQuote(html, quote);
      const headers = splitTableRow(trimmed);
      i += 2; // пропускаем заголовок + разделитель
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const head = headers.map((h) => `<th>${renderInline(h)}</th>`).join('');
      const body = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td>${renderInline(c)}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      html.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      );
      continue;
    }

    // Заголовки h1..h6 (KS-1987).
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList(html, list);
      flushQuote(html, quote);
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Цитата `> ...`.
    if (trimmed.startsWith('>')) {
      closeList(html, list);
      // Снимаем «> » префикс (или просто «>»).
      const inner = trimmed.replace(/^>\s?/, '');
      quote.open = true;
      quote.buf.push(inner);
      i += 1;
      continue;
    }

    // Нумерованный список.
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushQuote(html, quote);
      ensureList(html, list, 'ol');
      html.push(`<li>${renderInline(olMatch[2])}</li>`);
      i += 1;
      continue;
    }

    // Маркированный список.
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      flushQuote(html, quote);
      ensureList(html, list, 'ul');
      html.push(`<li>${renderInline(trimmed.slice(2))}</li>`);
      i += 1;
      continue;
    }

    // Обычный параграф.
    closeList(html, list);
    flushQuote(html, quote);
    html.push(`<p>${renderInline(trimmed)}</p>`);
    i += 1;
  }

  if (inCodeBlock) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  closeList(html, list);
  flushQuote(html, quote);

  return html.join('');
}
