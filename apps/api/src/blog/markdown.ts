/**
 * KS-4409 / ADR-137 rev2. Helper для рендера Markdown в HTML. Вызывается
 * из админ-CRUD (T3) на каждый save поста — результат кэшируется в
 * `blog_posts.body_html`. На публичных эндпоинтах рендер не делается,
 * отдаётся готовый HTML из БД.
 *
 * MVP-имплементация: `marked` (md → HTML) + лёгкая sanitizе-обёртка
 * regex'ами — режем `<script>`, `<iframe>`, `<object>`, `<embed>`,
 * `on*=` атрибуты и `javascript:` URL. Этого достаточно для MVP, где
 * админ-CRUD доступен только команде Kingside (после T3 — JWT + role
 * check). Для следующей итерации задача завести `rehype-sanitize`
 * (KS-4409 follow-up: добавить unified/rehype-sanitize в зависимости
 * apps/api после согласования с devops).
 */
import { marked } from 'marked';

/**
 * Удаляет потенциально опасные теги/атрибуты. Не пытается заменить
 * полноценный sanitizer (DOMPurify / rehype-sanitize) — этого делает
 * первая итерация, которая закроет случайный XSS в нашем
 * контролируемом контенте.
 */
function basicSanitize(html: string): string {
  let out = html;
  // Полностью удаляем содержимое опасных тегов вместе с тегами.
  out = out.replace(
    /<(script|style|iframe|object|embed|noscript|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  // Самозакрывающиеся варианты тех же тегов.
  out = out.replace(
    /<(script|style|iframe|object|embed|noscript|form)\b[^>]*\/?>(?!<\/\1>)/gi,
    '',
  );
  // Inline-обработчики `on...=` (onclick / onerror / onload / ...).
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // `javascript:` URL в href / src.
  out = out.replace(/\s(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  // `data:text/html` URL — векторы для xss через <iframe data:...>.
  out = out.replace(/\s(href|src)\s*=\s*("data:text\/html[^"]*"|'data:text\/html[^']*'|data:text\/html[^\s>]+)/gi, '');
  return out;
}

/**
 * Преобразовать Markdown в HTML. Возвращает санитизированный HTML,
 * безопасный для встраивания в страницу через `dangerouslySetInnerHTML`.
 */
export async function renderMarkdownToHtml(md: string): Promise<string> {
  const rawHtml = await Promise.resolve(
    marked.parse(md, { async: false, breaks: false, gfm: true }) as string,
  );
  return basicSanitize(rawHtml);
}
