/**
 * KS-2227 — `find-fork` тесты.
 */

import { findFork } from './find-fork';

describe('findFork — KS-2227', () => {
  it('конь c7 = вилка короля e8 + ладьи a8 → square c7', () => {
    const r = findFork('r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c7' },
    });
  });

  it('пешечная вилка не считается (pawn value=1, не ≥minor)', () => {
    // На e5 чёрные кони: d4 и f4 — белая пешка e5 их атакует, но
    // pawn в качестве forker'а отбрасывается (PIECE_VALUE < 3 для целей,
    // но pawn-forker — целевые ценные. Здесь специально проверяем: цели
    // — пешки, value=1, отброшены, fork=0).
    // Конь c3 атакует пешки b5 и d5 (вилка пешек) — pawn=1 не minor.
    const r = findFork('4k3/8/8/1p1p4/8/2N5/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('две вилки в позиции → drop', () => {
    // Конь c7 вилкует a8(R)+e8(K); конь f7 вилкует d8(Q)+h8(R).
    const r = findFork('r2qk2r/2N2N2/8/8/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('одна атакуемая ценная фигура → не вилка', () => {
    // Только король атакован конём → не fork (size < 2).
    const r = findFork('4k3/2N5/8/8/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('конь атакует короля и ферзя — вилка', () => {
    // Чёрные король e8 и ферзь c8, ход белых: конь d6 атакует обоих.
    const r = findFork('2q1k3/8/3N4/8/8/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'd6' },
    });
  });

  it('сторона на ходу = forker side', () => {
    // Чёрные на ходу: чёрный конь c3 вилкует Q a2 + R e2.
    const r = findFork('4k3/8/8/8/8/2n5/Q3R3/4K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c3' },
    });
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(findFork('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });
});
