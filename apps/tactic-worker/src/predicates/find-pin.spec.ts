/**
 * KS-2227 / KS-2615 — `find-pin` (абсолютные и относительные связки).
 */

import { findPin } from './find-pin';

describe('findPin — KS-2227 / KS-2615', () => {
  it('классический пин ладьёй: пешка c7 между ладьёй c1 и королём c8 — связана', () => {
    // KS-2615: вернули классическую семантику. Пешка c7 ходит только по
    // колонке c (c6/c5), но это всё равно связка по правилам шахмат.
    const r = findPin('2k5/2p5/8/8/8/8/8/2RK4 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c7' },
    });
  });

  it('пин коня: конь c7 между ладьёй c1 и королём c8', () => {
    const r = findPin('2k5/2n5/8/8/8/8/8/2RK4 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c7' },
    });
  });

  it('пин слона на короля по диагонали (ферзь a1, слон d4, король g7)', () => {
    const r = findPin('8/6k1/8/8/3b4/8/8/Q3K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'd4' },
    });
  });

  it('фигура между атакером и королём но НЕ дальнобойным = не пин', () => {
    const r = findPin('2k5/2p5/2N5/8/8/8/8/3K4 b - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('стартовая позиция → нет пинов', () => {
    const r = findPin(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(r.valid).toBe(false);
  });

  it('два пина → drop', () => {
    const r = findPin('4k3/2p2p2/8/8/8/8/8/2R2RK1 b - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('фигура НЕ перед королём (вне линии) — не пин', () => {
    const r = findPin('7k/8/1n6/8/8/8/8/R3K3 b - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(findPin('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });

  // ─── KS-2615: возврат классической семантики (отмена KS-2336/KS-2340) ──
  it('KS-2615: пешка g7 при короле g8 и ферзе g3 — связана (вертикальный pin)', () => {
    const r = findPin('6k1/6p1/8/8/8/6Q1/8/K7 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'g7' },
    });
  });

  it('KS-2615: пешка c5 при слоне a3 на чёрного короля e7 — связана (диагональная связка)', () => {
    const r = findPin('8/4k3/8/2p5/8/B7/8/4K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c5' },
    });
  });

  it('KS-2615: пешка g7 при ладье g6 рядом — связана (нет ходов, но классический pin остаётся)', () => {
    const r = findPin('6k1/6p1/6R1/8/8/8/8/K7 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'g7' },
    });
  });

  // ─── KS-2615: регрессии на конкретный баг ──────────────────────────
  it('KS-2615: тривиальный rook-пин — пешка d7 между ладьёй d2 и королём d8 — связана', () => {
    const r = findPin('3k4/3p4/8/8/8/8/3R4/4K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'd7' },
    });
  });

  it('KS-2615: относительная связка ладьёй — пешка d6 между ладьёй d1 и конём d7 — связана', () => {
    // Точно тот случай из жалобы пользователя (KS-2615): белая ладья
    // d1, чёрная пешка d6, чёрный конь d7. Если убрать пешку — ладья
    // атакует коня (anchor=knight=3 > pawn=1).
    const r = findPin('3n3k/8/3p4/8/8/8/8/3R3K w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'd6' },
    });
  });

  it('KS-2615: FEN из скриншота тренажёра — три связки d6/c4/e4, поэтому predicate отбраковывает', () => {
    const r = findPin(
      'b1rr1bk1/2qn1pp1/pp1ppnNp/8/2P1PB2/P1N2N1P/1P3PP1/1Q1RRBK1 w - - 0 1',
    );
    expect(r.valid).toBe(false);
    expect((r as { reason: string }).reason).toContain('found 3');
  });

  // ─── KS-2347: относительные связки ─────────────────────────────────
  it('KS-2347: конь связан слоном за ферзём (anchor=queen, относительная)', () => {
    const r = findPin('7k/8/5q2/8/3n4/8/8/B6K b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'd4' },
    });
  });

  it('KS-2347: конь связан ладьёй за ладьёй (anchor=rook, относительная)', () => {
    const r = findPin('4k3/8/8/8/8/8/8/R1n1r2K w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c1' },
    });
  });

  it('KS-2347: слон связан слоном за конём — НЕ связка (равная ценность)', () => {
    const r = findPin('5n2/8/3b4/8/8/B7/4k3/7K b - - 0 1');
    expect(r.valid).toBe(false);
  });
});
