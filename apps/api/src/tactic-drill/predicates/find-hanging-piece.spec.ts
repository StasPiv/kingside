/**
 * KS-2227 — `find-hanging-piece` тесты.
 */

import { findHangingPiece } from './find-hanging-piece';

describe('findHangingPiece — KS-2227', () => {
  it('чёрный конь e5 атакован, защитников нет → square e5', () => {
    // Белый ферзь e4 атакует чёрного коня e5; защитников у коня нет.
    // Других чёрных фигур кроме короля e8 нет.
    const r = findHangingPiece('4k3/8/8/4n3/4Q3/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'e5' },
    });
  });

  it('атакованная фигура с защитником → не hanging', () => {
    // Чёрный конь e5 атакован Q e4, но защищён чёрной пешкой d6.
    // Пешка d6 не атакована и без защитников — но она НЕ hanging
    // (нет атакующих). 0 кандидатов → drop.
    const r = findHangingPiece('4k3/8/3p4/4n3/4Q3/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('два hanging-кандидата → drop', () => {
    // Чёрный конь e5 и чёрный конь a4, оба без защитников и оба
    // атакованы белым ферзём e4 (по 4-й горизонтали и e-вертикали).
    const r = findHangingPiece('4k3/8/8/4n3/n3Q3/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('фигура без атакующих, без защитников → НЕ hanging (это loose)', () => {
    const r = findHangingPiece('4k3/8/8/4n3/8/8/8/4K3 w - - 0 1');
    // нет белых фигур → нет атакующих → конь не hanging (хотя loose).
    expect(r.valid).toBe(false);
  });

  it('король исключён из hanging-кандидатов', () => {
    // Только король и атакующий ферзь — не считается.
    const r = findHangingPiece('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('сторона на ходу = "наша" (which="hanging-for-us")', () => {
    // Чёрные на ходу. Белый слон f3 атакован чёрной ладьёй f8,
    // защитников у слона нет (между f8 и f3 пусто).
    const r = findHangingPiece('4kr2/8/8/8/8/5B2/8/4K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'f3' },
    });
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(findHangingPiece('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });
});
