/**
 * FEN normalization used as input for the archive position key.
 *
 * The position key (16-byte hash) stored in `position_stats.positionKey`
 * must be identical for the same chess position, regardless of move
 * counters. Halfmove clock and fullmove number are therefore stripped
 * before hashing.
 *
 * Both the archive import worker and the REST API must use this exact
 * normalization so a request from the client maps to the same key the
 * worker wrote to the database.
 *
 * Full FEN layout (6 space-separated fields):
 *   piecePlacement activeColor castling enPassant halfmoveClock fullmoveNumber
 *
 * We keep the first four fields.
 */
export function normalizeFenForKey(fen: string): string {
  const trimmed = fen.trim();
  if (!trimmed) {
    throw new Error('normalizeFenForKey: FEN is empty');
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 4) {
    throw new Error(
      `normalizeFenForKey: FEN must contain at least 4 fields, got ${parts.length}`,
    );
  }

  return parts.slice(0, 4).join(' ');
}
