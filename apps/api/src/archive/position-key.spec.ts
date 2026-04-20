import { positionKey, positionKeyHex } from './position-key';

describe('positionKey', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('returns a 16-byte Buffer', () => {
    const key = positionKey(startFen);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(16);
  });

  it('is deterministic for the same FEN', () => {
    const a = positionKey(startFen);
    const b = positionKey(startFen);
    expect(a.equals(b)).toBe(true);
  });

  it('ignores halfmove clock and fullmove number', () => {
    const withCounters = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 12';
    expect(positionKey(startFen).equals(positionKey(withCounters))).toBe(true);
  });

  it('ignores en-passant target square (KS-1598)', () => {
    // Position after 1.e4 — chess.js emits `e3` as e-p target even when no
    // capture is possible. The same layout reached via transposition may
    // have `-`. The openings tree must merge both forms.
    const e4WithEp =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const e4WithoutEp =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(positionKey(e4WithEp).equals(positionKey(e4WithoutEp))).toBe(true);
  });

  it('differs when side to move differs', () => {
    const black = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
    expect(positionKey(startFen).equals(positionKey(black))).toBe(false);
  });

  it('positionKeyHex produces 32 lowercase hex chars', () => {
    const hex = positionKeyHex(positionKey(startFen));
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
  });

  it('throws on empty or malformed FEN', () => {
    expect(() => positionKey('')).toThrow();
    expect(() => positionKey('not a fen')).toThrow();
  });
});
