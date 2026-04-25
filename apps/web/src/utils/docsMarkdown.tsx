import type { JSX, ReactNode } from 'react';

/**
 * `<DocsMarkdown>` — рендерер markdown для публичной документации
 * (`/docs/*` страницы, KS-1895).
 *
 * # Зачем отдельный парсер
 *
 * `simpleMarkdown.ts` намеренно узкий — он рендерит markdown, который
 * автор урока пишет в WYSIWYG-toolbar (KS-1874). Поддержка таблиц,
 * blockquote и `<h4>` там сделала бы рассинхрон между «что генерит
 * редактор» и «что рендерится» (ученик увидит сырой `**` если рендер
 * умнее редактора, или наоборот). Документация — другой контент,
 * source — полноценный markdown с таблицами/цитатами/якорями.
 *
 * Поэтому `docsMarkdown.tsx` — отдельный, полнее покрывающий, но
 * только в области документации. Зависимости: ноль (никакого
 * `react-markdown`/`remark-gfm` в bundle).
 *
 * # Поддерживается
 *
 * - Заголовки `#`–`######` (с автогенерацией id для якорной навигации,
 *   github-style slug включая кириллицу).
 * - Параграфы (пустая строка-разделитель).
 * - Горизонтальная линия `---`.
 * - Blockquote `>` (multi-line, склеивается).
 * - Bullet-list (`- `, `* `) и numbered (`1. `) с вложенностью по
 *   отступу из 2 пробелов.
 * - Fenced code-block ```` ``` ```` (без подсветки — в bundle нет
 *   highlight.js).
 * - Таблицы GFM `| col |` с separator-строкой `| --- |`.
 * - Inline: `**bold**`, `*italic*`, `` `code` ``, `[label](url)`,
 *   `![alt](src)`.
 *
 * Не поддерживается (намеренно): HTML-вставки, footnotes, task-lists,
 * автоматические URL-линки, strikethrough — в исходнике их нет.
 */

export interface DocsMarkdownProps {
  source: string;
  /**
   * Префикс для разрешения относительных ссылок на ресурсы
   * (картинки/ссылки начинающиеся с `./`). Например, для документа,
   * лежащего в `/docs/user-courses/user-courses.md`, передаётся
   * `/docs/user-courses/` — тогда `./screenshots/x.png` превратится
   * в `/docs/user-courses/screenshots/x.png`.
   */
  baseUrl?: string;
  /** Колбэк наталкивающихся на якорь-заголовки — для построения ToC. */
  onHeading?: (level: number, text: string, id: string) => void;
}

// ─── Slug ──────────────────────────────────────────────────────────────

/**
 * GitHub-style slug для русско-английских заголовков. Поддерживает
 * кириллицу. Используется для id-якоря и для разрешения ссылок типа
 * `[link](#section-name)`.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-zа-яё0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Inline ────────────────────────────────────────────────────────────

/**
 * Разбирает inline-markdown (внутри одной строки или абзаца). Возвращает
 * массив React-нод.
 */
function renderInline(
  text: string,
  baseUrl: string,
  keyPrefix = '',
): ReactNode[] {
  // Стратегия: ищем паттерны в порядке приоритета через единый regex с
  // group'ами; всё что не попало — текст. Картинка проверяется до
  // ссылки, чтобы `![alt](src)` не съелось как `[label](url)`.
  const tokens: ReactNode[] = [];
  const regex =
    /(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const key = `${keyPrefix}-${i++}`;
    if (match[1]) {
      // image
      const alt = match[2] ?? '';
      const src = resolveUrl(match[3] ?? '', baseUrl);
      tokens.push(<img key={key} src={src} alt={alt} loading="lazy" />);
    } else if (match[4]) {
      // link
      const label = match[5] ?? '';
      const url = match[6] ?? '';
      tokens.push(renderLink(label, url, baseUrl, key));
    } else if (match[7]) {
      tokens.push(<code key={key}>{match[8]}</code>);
    } else if (match[9]) {
      tokens.push(<strong key={key}>{match[10]}</strong>);
    } else if (match[11]) {
      tokens.push(<em key={key}>{match[12]}</em>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) tokens.push(text.slice(lastIndex));
  return tokens;
}

function renderLink(
  label: string,
  url: string,
  baseUrl: string,
  key: string,
): ReactNode {
  if (url.startsWith('#')) {
    // Внутренний якорь
    return (
      <a key={key} href={url}>
        {label}
      </a>
    );
  }
  const isExternal = /^(https?:|mailto:)/.test(url);
  if (isExternal) {
    return (
      <a key={key} href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  // Относительная ссылка — резолвим через baseUrl. Не превращаем в
  // `<Link>`-route — документация хостится статически, всё через
  // обычные anchor.
  return (
    <a key={key} href={resolveUrl(url, baseUrl)}>
      {label}
    </a>
  );
}

function resolveUrl(url: string, baseUrl: string): string {
  if (/^(https?:|mailto:|data:|#|\/)/.test(url)) return url;
  if (url.startsWith('./')) return baseUrl + url.slice(2);
  return baseUrl + url;
}

// ─── Block parser ──────────────────────────────────────────────────────

interface BlockContext {
  baseUrl: string;
  onHeading?: DocsMarkdownProps['onHeading'];
  /** Уникальный счётчик для key'ев. */
  counter: { n: number };
}

function nextKey(ctx: BlockContext): string {
  ctx.counter.n += 1;
  return `b-${ctx.counter.n}`;
}

/**
 * Парсит весь документ в массив React-блоков.
 */
export function parseBlocks(source: string, ctx: BlockContext): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Пустая строка
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // HR
    if (/^---+\s*$/.test(line)) {
      out.push(<hr key={nextKey(ctx)} />);
      i += 1;
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slugify(text);
      ctx.onHeading?.(level, text, id);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      out.push(
        <Tag key={nextKey(ctx)} id={id}>
          {renderInline(text, ctx.baseUrl, id)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // Fenced code
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      // skip closing ```
      if (i < lines.length) i += 1;
      out.push(
        <pre key={nextKey(ctx)} data-lang={lang || undefined}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Blockquote — склеиваем подряд идущие `>`-строки
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(
        <blockquote key={nextKey(ctx)}>
          {parseBlocks(buf.join('\n'), ctx)}
        </blockquote>,
      );
      continue;
    }

    // Table (GFM)
    if (/^\s*\|/.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(tableLines, ctx));
      continue;
    }

    // List (bullet или ordered)
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const listLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i].trim() === '' ||
          /^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) ||
          /^\s{2,}\S/.test(lines[i])) // continuation
      ) {
        if (lines[i].trim() === '') {
          // peek: если следующая — list-item, продолжаем; иначе break.
          if (
            i + 1 < lines.length &&
            /^(\s*)([-*]|\d+\.)\s+/.test(lines[i + 1])
          ) {
            listLines.push(lines[i]);
            i += 1;
            continue;
          }
          break;
        }
        listLines.push(lines[i]);
        i += 1;
      }
      out.push(renderList(listLines, ctx));
      continue;
    }

    // Параграф — склеиваем строки до пустой
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !/^\s*\|/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) {
      // Если параграф содержит только одну image-разметку — рендерим как
      // самостоятельный <figure>, чтобы стилизовать отдельно.
      const trimmed = para.join(' ').trim();
      const onlyImage = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (onlyImage) {
        const alt = onlyImage[1];
        const src = resolveUrl(onlyImage[2], ctx.baseUrl);
        out.push(
          <figure key={nextKey(ctx)} className="docs-figure">
            <img src={src} alt={alt} loading="lazy" />
            {alt && <figcaption>{alt}</figcaption>}
          </figure>,
        );
      } else {
        out.push(
          <p key={nextKey(ctx)}>
            {renderInline(para.join(' '), ctx.baseUrl, nextKey(ctx))}
          </p>,
        );
      }
    }
  }

  return out;
}

// ─── Tables ────────────────────────────────────────────────────────────

function splitRow(row: string): string[] {
  // Убираем крайние `|` и сплитим. Не поддерживает экранированный `\|`
  // (в исходнике не используется).
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

function renderTable(rows: string[], ctx: BlockContext): ReactNode {
  if (rows.length < 2) {
    // не таблица; рендерим как параграф fallback
    return (
      <p key={nextKey(ctx)}>
        {renderInline(rows.join('\n'), ctx.baseUrl, nextKey(ctx))}
      </p>
    );
  }
  const headerCells = splitRow(rows[0]);
  // вторая строка — separator `| --- |`. Пропускаем её, проверять не
  // обязательно — формат фиксирован.
  const bodyRows = rows.slice(2).map(splitRow);
  return (
    <div className="docs-table-wrap" key={nextKey(ctx)}>
      <table className="docs-table">
        <thead>
          <tr>
            {headerCells.map((c, idx) => (
              <th key={idx}>{renderInline(c, ctx.baseUrl, `th-${idx}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((c, cIdx) => (
                <td key={cIdx}>
                  {renderInline(c, ctx.baseUrl, `td-${rIdx}-${cIdx}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Lists ─────────────────────────────────────────────────────────────

interface ListItem {
  marker: 'bullet' | 'ordered';
  indent: number;
  content: string[];
}

function renderList(rawLines: string[], ctx: BlockContext): ReactNode {
  // Разбиваем последовательные строки на items (учитываем continuation).
  const items: ListItem[] = [];
  for (const ln of rawLines) {
    if (ln.trim() === '') continue;
    const m = ln.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (m) {
      const indent = m[1].length;
      const marker = m[2] === '-' || m[2] === '*' ? 'bullet' : 'ordered';
      items.push({ marker, indent, content: [m[3]] });
    } else if (items.length > 0) {
      // continuation — продолжение последнего item'а
      items[items.length - 1].content.push(ln.trim());
    }
  }

  // Группируем рекурсивно по уровню indent.
  const root = nest(items, 0, ctx);
  return root;
}

function nest(
  items: ListItem[],
  startIndent: number,
  ctx: BlockContext,
): ReactNode {
  // Берём префикс items с indent === startIndent (или относительно
  // первого item). Внутри них отдельные «глубже»-children идут как
  // вложенный <ul>/<ol>.
  if (items.length === 0) return null;
  const baseIndent = items[0].indent;
  const Tag = items[0].marker === 'ordered' ? 'ol' : 'ul';
  const out: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.indent < baseIndent) break;
    if (it.indent > baseIndent) {
      // не должно случиться — сначала заходит item с baseIndent
      i += 1;
      continue;
    }
    // children — все последующие items с indent > baseIndent, до
    // следующего item'а с indent == baseIndent или меньше.
    const childStart = i + 1;
    let childEnd = childStart;
    while (
      childEnd < items.length &&
      items[childEnd].indent > baseIndent
    ) {
      childEnd += 1;
    }
    const children = items.slice(childStart, childEnd);
    const itemContent = it.content.join(' ');
    out.push(
      <li key={`li-${nextKey(ctx)}`}>
        {renderInline(itemContent, ctx.baseUrl, `inl-${i}`)}
        {children.length > 0 && nest(children, baseIndent + 2, ctx)}
      </li>,
    );
    i = childEnd;
  }
  return <Tag key={nextKey(ctx)}>{out}</Tag>;
  void startIndent; // not used directly, baseIndent держится из items
}

// ─── Public component ─────────────────────────────────────────────────

export function DocsMarkdown({
  source,
  baseUrl = '',
  onHeading,
}: DocsMarkdownProps): JSX.Element {
  const ctx: BlockContext = { baseUrl, onHeading, counter: { n: 0 } };
  const blocks = parseBlocks(source, ctx);
  return <div className="docs-content">{blocks}</div>;
}

/**
 * Чистый сбор h2-заголовков из markdown-исходника. Используется для
 * построения ToC до того как markdown отрендерится в JSX (без вторых
 * проходов по дереву и без StrictMode-двойных вызовов).
 */
export function extractH2Headings(
  source: string,
): Array<{ level: 2; text: string; id: string }> {
  const out: Array<{ level: 2; text: string; id: string }> = [];
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: 2, text: m[1], id: slugify(m[1]) });
  }
  return out;
}

// для тестов
export const __testing = { renderInline, slugify, escapeHtml };
