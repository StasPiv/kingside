/**
 * KS-2474: извлечение формата турнира из хвоста `Broadcast.title`.
 *
 * Lichess не всегда отдаёт `tour.info.format`; пример — Sardinia World
 * Chess Festival 2026 | Open A | 9-round Swiss, где «9-round Swiss»
 * сидит в названии трансляции после последнего разделителя `|`.
 * Без явного формата детектор `detectRoundTournamentType` опирается
 * только на эвристику имени раунда / структуру пар, что приводит к
 * ложной классификации швейцарок как playoff.
 *
 * Функция извлекает «format-like» хвост названия:
 *   - последняя часть после `|`, `—`, `–`, `-` (с пробелами по краям);
 *   - если содержит маркер `Swiss` / `Round Robin` / `Knockout` /
 *     `Single-/Double-elimination` (case-insensitive) — возвращается
 *     как есть;
 *   - иначе `null`.
 *
 * Чистая функция, никаких внешних зависимостей. Используется в
 * `broadcast-sync.service.ts::upsertBroadcast` как fallback для
 * `info.format`.
 */

const FORMAT_MARKER =
  /\b(?:swiss|round[- ]?robin|knock[- ]?out|elimination|single[- ]?elim|double[- ]?elim|match)\b/i;

const TITLE_SEPARATORS = /\s[|—–-]\s/g;

export function extractTournamentFormatFromTitle(
  title: string | null | undefined,
): string | null {
  if (!title) return null;
  const trimmed = title.trim();
  if (!trimmed) return null;

  // Сначала пробуем последний сегмент после разделителя.
  const segments = trimmed.split(TITLE_SEPARATORS).map((s) => s.trim()).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (FORMAT_MARKER.test(seg)) return seg;
  }
  // Fallback — если разделителей нет, но в самом title содержится маркер
  // (например `9-round Swiss Sardinia 2026`), возвращаем весь title:
  // детектору хватит regex'а по подстроке для классификации.
  if (FORMAT_MARKER.test(trimmed)) return trimmed;
  return null;
}
