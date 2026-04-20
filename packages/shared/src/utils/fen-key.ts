/**
 * FEN normalization used as input for the archive position key.
 *
 * The position key (16-byte hash) stored in `position_stats.positionKey`
 * must be identical for the same chess position, regardless of move
 * counters OR en-passant target square.
 *
 * Both the archive import worker and the REST API must use this exact
 * normalization so a request from the client maps to the same key the
 * worker wrote to the database.
 *
 * Full FEN layout (6 space-separated fields):
 *   piecePlacement activeColor castling enPassant halfmoveClock fullmoveNumber
 *
 * We keep the first three fields (piece placement + active color + castling).
 *
 * En-passant is deliberately dropped: for the openings tree we want the
 * position "after 1.e4" (FEN contains `e3` as e-p target) to merge with
 * the same position reached via a transposition where the e-p flag is
 * absent. chess.js always emits an e-p square after a 2-square pawn move
 * even when no capture is actually possible, so keeping it would split
 * identical positions into separate tree nodes (KS-1598).
 *
 * Halfmove clock and fullmove number are irrelevant to position identity
 * and are likewise stripped.
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

  return parts.slice(0, 3).join(' ');
}
