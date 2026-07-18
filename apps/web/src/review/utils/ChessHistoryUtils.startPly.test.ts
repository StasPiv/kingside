import { describe, it, expect } from 'vitest';
import { startPlyFromFen } from './ChessHistoryUtils';

// KS-4983: стартовый ply первого хода из FEN с учётом fullmove и стороны.
describe('startPlyFromFen (KS-4983)', () => {
  it('белые к ходу, fullmove N → 2N-1', () => {
    expect(startPlyFromFen('8/8/8/8/8/8/8/8 w - - 0 15')).toBe(29);
    expect(
      startPlyFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ).toBe(1);
  });

  it('чёрные к ходу, fullmove N → 2N', () => {
    expect(startPlyFromFen('8/8/8/8/8/8/8/8 b - - 0 15')).toBe(30);
    expect(startPlyFromFen('8/8/8/8/8/8/8/8 b - - 0 1')).toBe(2);
  });

  it('невалидный / пустой / отсутствующий fullmove → 1', () => {
    expect(startPlyFromFen('')).toBe(1);
    expect(startPlyFromFen(null)).toBe(1);
    expect(startPlyFromFen(undefined)).toBe(1);
    expect(startPlyFromFen('8/8/8/8/8/8/8/8 w - - 0 x')).toBe(1);
  });
});
