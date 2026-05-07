/**
 * KS-2560: keyset-cursor codec для `GET /puzzles/browse`.
 *
 * Cursor = `base64url(JSON({c: ISO-timestamp, i: puzzleId}))`. Без
 * перебора всех совпадающих строк сервер берёт следующие через
 * keyset: `(created_at, id) < (cursor.c, cursor.i)` ORDER BY
 * `(created_at, id)` DESC. Эффективно через индекс
 * `puzzles_created_at_idx` (KS-2557).
 *
 * Шапку JSON делаем терсовой (single-letter keys) — курсор пойдёт в
 * URL, чем короче тем лучше:
 *   `c` — ISO-строка `created_at`.
 *   `i` — `puzzles.id` (lichess короткий код или UUID generated).
 *
 * Невалидный / пустой cursor → `null`. Сервис трактует это как
 * «первая страница», не ошибка.
 */

export interface PuzzleCursor {
  c: string;
  i: string;
}

export function encodePuzzleCursor(cursor: PuzzleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePuzzleCursor(
  raw: string | undefined | null,
): PuzzleCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as PuzzleCursor).c !== 'string' ||
      typeof (parsed as PuzzleCursor).i !== 'string'
    ) {
      return null;
    }
    // Валидируем что `c` парсится как Date — иначе SQL `::timestamp`
    // упадёт.
    if (Number.isNaN(Date.parse((parsed as PuzzleCursor).c))) return null;
    return parsed as PuzzleCursor;
  } catch {
    return null;
  }
}
