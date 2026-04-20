import { createHash } from 'node:crypto';
import { normalizeFenForKey } from './fen-key.js';

/**
 * Computes the 16-byte archive position key from a FEN string.
 *
 * This is the same key stored in `position_stats.positionKey`. Must match
 * across the archive import worker and the REST API so API lookups resolve
 * to the rows the worker wrote.
 *
 * Algorithm:
 *   1. Normalize FEN via `normalizeFenForKey` — drop move counters (halfmove
 *      clock and fullmove number).
 *   2. SHA-1 over the UTF-8 bytes of the normalized FEN.
 *   3. Take the first 16 bytes.
 *
 * The 16-byte width matches `@db.Bytes` of the PK column and keeps indexes
 * compact. A cryptographic hash is used — not Zobrist — because it needs
 * no shared keying material between worker and API while remaining
 * deterministic across processes and restarts.
 */
export function positionKey(fen: string): Buffer {
  const normalized = normalizeFenForKey(fen);
  const digest = createHash('sha1').update(normalized, 'utf8').digest();
  return digest.subarray(0, 16);
}

/** Lowercase hex encoding of a position key — used in responses and cache keys. */
export function positionKeyHex(key: Buffer): string {
  return key.toString('hex');
}
