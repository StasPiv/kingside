/**
 * KS-2227 — `find-all-checks` тесты.
 */

import { findAllChecks } from './find-all-checks';

describe('findAllChecks — KS-2227', () => {
  it('4 разных шаха ферзём a1 → squares', () => {
    const r = findAllChecks('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1');
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.answer.shape).toBe('squares');
      expect(r.answer.squares.sort()).toEqual(['a4', 'a8', 'e5', 'h8']);
    }
  });

  it('один шах → drop (нужно ≥2)', () => {
    // Только ладья e1 — один шах Re8+.
    const r = findAllChecks('4k3/8/8/8/8/8/8/4R1K1 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('позиция с матом в один → drop (пересекается с find-mate-in-one)', () => {
    // Back-rank mate — должен отброситься.
    const r = findAllChecks('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('стартовая позиция → нет шахов → drop', () => {
    const r = findAllChecks(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(r.valid).toBe(false);
  });

  it('три разных to от двух коней (без мата) → squares', () => {
    // Белые кони b4 и f4, чёрный король e5. Шахи: Nb4-c6+, Nb4-d3+,
    // Nf4-g6+, Nf4-d3+ → 3 уникальные to: c6, d3, g6.
    const r = findAllChecks('8/8/8/4k3/1N3N2/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.answer.squares.sort()).toEqual(['c6', 'd3', 'g6']);
    }
  });

  it('чёрные на ходу: шахи чёрных фигур', () => {
    // Чёрный ферзь a8, белый король e1.
    const r = findAllChecks('q3k3/8/8/8/8/8/8/4K3 b - - 0 1');
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.answer.squares.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(findAllChecks('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });
});
