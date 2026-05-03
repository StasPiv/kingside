/**
 * KS-2227 — `find-loose-piece` тесты.
 * 5+ FEN: разные «loose» фигуры, edge-cases (защитники, король,
 * стартовая позиция).
 */

import { findLoosePiece } from './find-loose-piece';

describe('findLoosePiece — KS-2227', () => {
  it('единственный непокрытый чёрный конь → square e5', () => {
    // Белые на ходу. Чёрный конь e5, защитников нет, других чёрных
    // фигур (кроме короля e8) тоже нет — ровно одна loose фигура.
    const r = findLoosePiece('4k3/8/8/4n3/8/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'e5' },
    });
  });

  it('фигура с защитником → не loose (0 кандидатов → drop)', () => {
    // Чёрный конь e5 защищён чёрной пешкой f6, пешка f6 защищена
    // чёрным королём e7. 0 loose-кандидатов.
    const r = findLoosePiece('8/4k3/5p2/4n3/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('два loose-кандидата → drop (не валидный drill)', () => {
    // Чёрный конь e5 + чёрный слон h6, оба без защитников.
    const r = findLoosePiece('4k3/8/7b/4n3/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('король исключён из loose-кандидатов', () => {
    // Только король и пешка с защитником — нет loose фигур.
    const r = findLoosePiece('4k3/4p3/8/8/8/8/8/4K3 w - - 0 1');
    // Король не считается, у пешки e7 защитник = чёрный король →
    // defenders ≠ 0, тоже не loose.
    expect(r.valid).toBe(false);
  });

  it('стартовая позиция → нет loose фигур (все защищены)', () => {
    const r = findLoosePiece(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(r.valid).toBe(false);
  });

  it('сторона на ходу не важна для определения loose, но enemy = opp(turn)', () => {
    // Чёрные на ходу. Белый слон f3 — без защитников, в окружении
    // белых пусто.
    const r = findLoosePiece('4k3/8/8/8/8/5B2/8/4K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'square', square: 'f3' },
    });
  });

  it('невалидный FEN → reason invalid_fen', () => {
    const r = findLoosePiece('not-a-fen');
    expect(r).toEqual({ valid: false, reason: 'invalid_fen' });
  });
});
