/**
 * KS-2064 / ADR-033 §4.4.3:
 * Нормализация имён игроков и турниров для архивной (мастерской) базы.
 *
 * Применяется одинаково на write (backfill, инкрементальный апдейт после
 * импорта) и read (входящий `q` в endpoint'ах
 * `/api/archive/players/search`, `/api/archive/events/search`) — иначе
 * GIN-индекс по `name_aliases gin_trgm_ops` не сматчит запрос с записями.
 *
 * Алгоритм:
 *   1. lowercase;
 *   2. NFKD + удаление диакритики (Unicode Combining Marks U+0300..U+036F)
 *      — `Müller` → `muller`, `Caruana` → `caruana`, `Карякин` → `карякин`
 *      (русская диакритика — это собственно буквы, она не комбинируется);
 *   3. замена пунктуации/разделителей `,`, `.`, `;`, `:`, `'`, `"`, `-`,
 *      `_`, `/`, `\` на пробел;
 *   4. collapse последовательностей пробелов в один пробел + trim.
 *
 * `archiveSlug(name)` = `nameNormalized.replace(/\s+/g, '-')` —
 * стабильный URL-safe идентификатор. Совпадает у `Carlsen, Magnus` и
 * `Carlsen,M.` (после нормализации обе → `carlsen m`).
 */

const COMBINING_MARKS_RE = /[̀-ͯ]/g;
const PUNCTUATION_RE = /[,.;:'"\-_/\\]/g;
const WHITESPACE_RE = /\s+/g;

/** Возвращает нормализованную форму имени для матчинга и индекса. */
export function normalizeArchiveName(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .toLowerCase()
    .replace(PUNCTUATION_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/**
 * URL-safe slug на базе нормализованной формы. Возвращает пустую строку
 * для пустого/мусорного входа — вызывающий код должен такие записи
 * пропускать (нет смысла индексировать «безымянного» игрока).
 */
export function archiveSlug(raw: string): string {
  const normalized = normalizeArchiveName(raw);
  if (!normalized) return '';
  return normalized.replace(/\s+/g, '-');
}
