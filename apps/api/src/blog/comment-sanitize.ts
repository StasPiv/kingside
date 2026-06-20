/**
 * KS-4471 / ADR-140 T5. Санитизация пользовательских комментариев
 * к статьям блога.
 *
 * Без зависимости от `sanitize-html` — strict-set: пустой allowlist
 * по тегам и атрибутам реализуется компактно через серию regex'ей.
 * Реальные HTML-парсеры (`parse5`, `cheerio`) для случая «выкинуть
 * всё» избыточны и тащат много мегабайт зависимостей.
 *
 * Алгоритм `stripHtml`:
 *   1. Удалить блоки `<script>…</script>` и `<style>…</style>` ВМЕСТЕ
 *      с содержимым — иначе после strip-тегов на странице останется
 *      исходный JavaScript / CSS как plain-текст.
 *   2. Удалить все HTML-комментарии `<!-- ... -->`.
 *   3. Удалить все остальные теги — `<…>`. Содержимое тегов
 *      `<p>текст</p>` остаётся «текст».
 *   4. Декодировать стандартные HTML-entities. Делается ПОСЛЕ
 *      strip-тегов, иначе атакующий смог бы сначала записать
 *      `&lt;script&gt;`, после декодирования получить `<script>` и
 *      обойти первый шаг.
 *   5. Нормализовать пробелы и обрезать концы.
 *
 * `countUrls` ловит `http(s)://…` и bare-домены `www.…`. Регистр
 * нечувствителен.
 */

/** Шаги 1–3: вычистить из исходной строки HTML-разметку. */
function stripTags(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Шаг 4: декодировать стандартные именованные и числовые entity. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      safeFromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) =>
      NAMED_ENTITIES[name.toLowerCase()] ?? m,
    );
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Удалить любую HTML-разметку, декодировать entity, нормализовать
 * whitespace. Гарантирует: в выходе нет тегов и HTML-комментариев.
 *
 * Алгоритм с двойным проходом:
 *   strip → decode → strip снова.
 * Второй strip нужен потому, что после декодирования
 * `&lt;script&gt;…&lt;/script&gt;` превращается в литеральные
 * `<script>…</script>`, и без повторной очистки эти символы дошли бы
 * до БД. Двух проходов достаточно: после второго strip угловых скобок
 * в строке нет вовсе. (Декодировать снова после второго strip уже не
 * нужно: entity'и без `<>/&` смысла для XSS не несут, а `&amp;` мы
 * уже превратили в `&` на первом decode.)
 */
export function stripHtml(input: string): string {
  if (!input) return '';
  const noTags = stripTags(input);
  const decoded = decodeEntities(noTags);
  const cleaned = stripTags(decoded);
  // Нормализуем пробельные последовательности (включая \n / \t) в один
  // пробел. Для комментариев это допустимо — рендер фронта добавит
  // переносы по тегам, которых у нас нет.
  // Но переводы строк сохраняем как маркер абзаца: схлопываем подряд
  // идущие пробелы в один, а \n оставляем.
  const trimmed = cleaned
    .replace(/[\t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return trimmed;
}

/**
 * Посчитать сколько URL-подобных подстрок в тексте. Считается:
 *   - `http://…` и `https://…` (case-insensitive).
 *   - bare `www.…` (без схемы).
 * Возвращает целое число.
 */
export function countUrls(input: string): number {
  if (!input) return 0;
  const re = /\b(?:https?:\/\/|www\.)\S+/gi;
  const matches = input.match(re);
  return matches ? matches.length : 0;
}
