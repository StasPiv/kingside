import type { ArchiveGameResult } from '@kingside/shared';

/**
 * Conversion between the wire-format ({@link ArchiveGameResult}) and the
 * storage-format used in `archive_game_positions.result` (CHAR(1)).
 *
 * Storage uses compact single characters to keep index entries small:
 *   'w' — white wins (wire: '1-0')
 *   'b' — black wins (wire: '0-1')
 *   'd' — draw       (wire: '1/2-1/2')
 *   NULL — unknown / ongoing (wire: '*' or null)
 *
 * The worker writes storage-format (KS-1610); the API must translate in
 * both directions: filters (wire → storage) and response items (storage →
 * wire).
 */

/** Map wire-format result filter to the storage character, or null for `*`. */
export function resultFilterToStorage(
  result: ArchiveGameResult | undefined | null,
): 'w' | 'b' | 'd' | null | undefined {
  if (result === undefined) return undefined;
  if (result === null || result === '*') return null;
  if (result === '1-0') return 'w';
  if (result === '0-1') return 'b';
  if (result === '1/2-1/2') return 'd';
  return undefined;
}

/** Map storage character back to the wire-format result. */
export function storageToResult(
  raw: string | null | undefined,
): ArchiveGameResult | null {
  if (raw == null) return null;
  if (raw === 'w') return '1-0';
  if (raw === 'b') return '0-1';
  if (raw === 'd') return '1/2-1/2';
  // Defensive: the worker should never store anything else, but if a stale
  // row from an earlier format survives, fall back to null rather than throw.
  return null;
}
