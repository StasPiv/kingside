/**
 * Simple markdown renderer — no external dependencies.
 * Supports: **bold**, *italic*, `code`, ```code blocks```, - lists, [links](url), headings (#).
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
