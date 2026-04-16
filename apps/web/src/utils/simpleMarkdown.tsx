/**
 * Simple markdown renderer — no external dependencies.
 * Supports: **bold**, *italic*, `code`, ```code blocks```, - lists, [links](url), headings (#).
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

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let inList = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        if (inList) { html.push('</ul>'); inList = false; }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      if (inList) { html.push('</ul>'); inList = false; }
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (inList) { html.push('</ul>'); inList = false; }
      const level = headingMatch[1].length;
      html.push(`<h${level + 2}>${renderInline(headingMatch[2])}</h${level + 2}>`);
      continue;
    }

    // List items
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
      if (!inList) { html.push('<ul>'); inList = true; }
      const content = trimmed.replace(/^[-*]\s|^\d+\.\s/, '');
      html.push(`<li>${renderInline(content)}</li>`);
      continue;
    }

    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<p>${renderInline(trimmed)}</p>`);
  }

  if (inCodeBlock) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  if (inList) html.push('</ul>');

  return html.join('');
}
