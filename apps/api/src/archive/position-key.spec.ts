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
