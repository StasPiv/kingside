/**
 * KS-2227 / KS-2335 / KS-2337 — `find-hanging-piece` (move-shape).
 *
 * 8 кейсов из ТЗ §4.3.
 */

import { findHangingPiece } from './find-hanging-piece';

describe('findHangingPiece — KS-2335 (shape=move)', () => {
  it('A: 1 атакующий, легальное взятие → {shape:"move", from, to}', () => {
    // Белый ферзь e4 атакует чёрного коня e5; защитников нет.
    const r = findHangingPiece('4k3/8/8/4n3/4Q3/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'e4', to: 'e5' },
    });
  });

  it('B: 2 наших атакующих (Q+N бьют e5) → drop с found 2', () => {
    const r = findHangingPiece('4k3/8/8/4n3/4Q3/3N4/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toContain('found 2');
    }
  });

  it('C: 1 атакующий, но связан → drop с found 0', () => {
    // Белый король a1, белая ладья b1 связана горизонтальной чёрной
    // ладьёй h1; единственный hanging-кандидат — конь b3 (атакует
    // только Rb1). Rxb3 нелегально (открывает шах от h1). Чёрный
    // конь g3 защищает h1 (иначе h1 тоже была бы hanging-целью).
    const r = findHangingPiece('4k3/8/8/8/8/1n4n1/8/KR5r w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toContain('found 0');
    }
  });

  it('D: 1 атакующий, но взятие открывает шах → drop с found 0', () => {
    // Семантически отдельный сценарий ТЗ §3.1: единственное
    // взятие нелегально из-за шаха, открывающегося после ухода
    // атакующего. По функциональному поведению (chess.js фильтрует
    // illegal-ходы) сводится к C — captures.length === 0 → drop.
    const r = findHangingPiece('4k3/8/8/8/8/1n4n1/8/KR5r w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('E: единственный атакующий — пешка с promotion → drop', () => {
    // Чёрный конь h8 (висит); единственный атакующий — белая пешка g7
    // (gxh8=Q/R/B/N). Все ходы — promotion-capture; v1 их отбрасывает.
    const r = findHangingPiece('2k4n/6P1/8/8/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toContain('found 0');
    }
  });

  it('F: 2+ висящих фигур → drop (на этапе targets)', () => {
    // Чёрный конь e5 и чёрный конь a4 — оба без защитников и атакованы
    // белым ферзём e4. До этапа capture-фильтра не доходит.
    const r = findHangingPiece('4k3/8/8/4n3/n3Q3/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toContain('hanging target');
    }
  });

  it('G: side-to-move=b → ищем висящие у белых', () => {
    // Чёрные на ходу. Белый слон f3 атакован чёрной ладьёй f8,
    // защитников нет. Ход Rxf3.
    const r = findHangingPiece('4kr2/8/8/8/8/5B2/8/4K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'f8', to: 'f3' },
    });
  });

  it('H: невалидный FEN → invalid_fen', () => {
    expect(findHangingPiece('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });
});
