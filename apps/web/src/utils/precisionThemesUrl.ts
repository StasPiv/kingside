/**
 * KS-3362 (ADR-080 §7 F2). URL-state хелперы для precision-тем.
 *
 * URL contract:
 *   - `?themes=pin,fork,sacrifice` (CSV) — выбранные темы.
 *   - Пустой/отсутствует → нет фильтра.
 *   - Backward-compat: одна тема `?themes=convertAdvantage` (single
 *     legacy KS-3147 / objective) поддерживается parse'ом — но objective
 *     теперь живёт в отдельном параметре `?objective=…`, так что
 *     практически коллизий нет. Если кто-то всё-таки положит legacy
 *     значение в `?themes=` — оно прорезается как обычная тема.
 *
 * Whitelist (`PRECISION_RELEVANT_THEMES`) применяем при чтении, чтобы
 * мусорные/неизвестные ключи в URL не путали бэкенд. Гость как
 * любой другой юзер — фильтр по темам работает одинаково для всех.
 */
import {
  PRECISION_RELEVANT_THEMES,
  isPrecisionRelevantTheme,
} from '@kingside/shared';

/**
 * Разобрать `?themes=…` в массив тем (с whitelist-фильтрацией).
 * Дубликаты схлопываются. Порядок — как в URL.
 */
export function readPrecisionThemesFromUrl(
  searchParams: URLSearchParams,
): string[] {
  const raw = searchParams.get('themes');
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!isPrecisionRelevantTheme(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Записать массив тем в URLSearchParams (mutates copy). Пустой массив
 * удаляет параметр.
 */
export function writePrecisionThemesToUrl(
  searchParams: URLSearchParams,
  themes: ReadonlyArray<string>,
): URLSearchParams {
  const sp = new URLSearchParams(searchParams);
  if (themes.length === 0) {
    sp.delete('themes');
  } else {
    // Сортируем в порядке whitelist'а — стабильный URL независимо от
    // порядка выбора в UI (важно для кэша на backend, ADR-080 §4.2).
    const order = new Map(
      PRECISION_RELEVANT_THEMES.map((t, i) => [t as string, i]),
    );
    const sorted = [...themes]
      .filter((t) => isPrecisionRelevantTheme(t))
      .sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
    sp.set('themes', sorted.join(','));
  }
  return sp;
}
