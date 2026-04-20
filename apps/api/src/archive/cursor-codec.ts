/**
 * Keyset-cursor codec for `GET /api/archive/games/by-position`.
 *
 * The cursor is a base64url-encoded JSON object:
 *   sort=recent  → { t: ISO-date | null, g: UUID }
 *   sort=topElo  → { e: number | null,   g: UUID }
 *
 * `t === null` / `e === null` means the reader is inside the trailing
 * "NULLS LAST" block (rows without `played_at` or `avg_elo` respectively).
 *
 * The JSON shape is intentionally terse (single-letter keys) to keep
 * cursor strings short — users will see them in URLs.
 */

export type RecentCursor = { t: string | null; g: string };
export type TopEloCursor = { e: number | null; g: string };
export type ArchiveCursor = RecentCursor | TopEloCursor;

export function encodeCursor(cursor: ArchiveCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor. Returns `null` when the cursor is empty or malformed —
 * treat this as "first page", not as an error. The service must validate
 * the decoded shape against the requested sort (see {@link isRecentCursor}
 * / {@link isTopEloCursor}).
 */
export function decodeCursor(raw: string | undefined | null): ArchiveCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ArchiveCursor;
  } catch {
    return null;
  }
}

export function isRecentCursor(c: ArchiveCursor | null): c is RecentCursor {
  if (!c) return false;
  return 't' in c && typeof (c as RecentCursor).g === 'string';
}

export function isTopEloCursor(c: ArchiveCursor | null): c is TopEloCursor {
  if (!c) return false;
  return 'e' in c && typeof (c as TopEloCursor).g === 'string';
}
