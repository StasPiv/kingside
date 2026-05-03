/**
 * KS-2227 — `find-pin` (абсолютные связки) тесты.
 */

import { findPin } from './find-pin';

describe('findPin — KS-2227', () => {
  it('классический пин: ладья c1 пинит пешку c7 на короля c8', () => {
    const r = findPin('2k5/2p5/8/8/8/8/8/2RK4 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'c7' },
    });
  });

  it('пин слона на короля по диагонали (ферзь a1, слон d4, король g7)', () => {
    // Чёрный слон d4 связан белым ферзём a1 на чёрного короля g7
    // (диагональ a1-h8: a1, b2, c3, d4, e5, f6, g7).
    const r = findPin('8/6k1/8/8/3b4/8/8/Q3K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'd4' },
    });
  });

  it('фигура между атакером и королём но НЕ дальнобойным = не пин', () => {
    // Конь c7 ничего не «пинит» — это не slider.
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
    // Чёрная пешка c7 связана ладьёй c1; чёрная пешка f7 связана
    // ладьёй f1; король e8.
    const r = findPin('4k3/2p2p2/8/8/8/8/8/2R2RK1 b - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('фигура НЕ перед королём (вне линии) — не пин', () => {
    // Чёрный конь b6 не на линии между ладьёй a1 и королём h8.
    const r = findPin('7k/8/1n6/8/8/8/8/R3K3 b - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(findPin('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });
});
