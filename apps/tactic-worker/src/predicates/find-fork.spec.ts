/**
 * KS-2227 / KS-2399 / KS-2400 / KS-2406 / KS-2408 — `find-fork` тесты.
 *
 * Семантика после KS-2400: shape='move'.
 * KS-2406: safety-check форкера (если форкер сам под боем — drop).
 * KS-2408: сравнение targetsBefore/targetsAfter ПО ФОРКЕРУ — ход
 * не считается creator'ом, если новые цели пересекаются с тем, что
 * та же фигура уже атаковала до хода.
 */

import { findFork } from './find-fork';

describe('findFork — KS-2400 (shape="move")', () => {
  it('Nb5-c7: новая вилка короля e8 + ладьи a8 → {from:b5, to:c7}', () => {
    // Конь b5 на ходу. Единственный ход, дающий новую вилку — Nc7.
    // attacksBefore[b5]={} (b5 не атакует ценных). После Nc7:
    // targetsAfter[c7]={a8(R), e8(K)}. Intersect=∅ → clean.
    const r = findFork('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'b5', to: 'c7' },
    });
  });

  it('конь уже на c7 (вилка стоит до хода) → drop', () => {
    // attacksBefore[c7]={a8, e8}. Все ходы коня переносят его на
    // клетки, где он атакует <2 ценных, или происходит overlap по
    // тем же фигурам. → 0 кандидатов.
    const r = findFork('r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('одна атакуемая ценная фигура → не вилка', () => {
    // Ход коня b5-d6: атакует только e8 (K). c8 пусто. Не fork.
    const r = findFork('4k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('пешечные цели (value=1) не считаются → drop', () => {
    // Конь c3 после Nb5 атаковал бы пешки a7/c7 — но pawn=1 < 3,
    // не «ценные». Никакой ход не делает вилку из ценных целей.
    const r = findFork('4k3/p1p5/8/8/8/2N5/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('KS-2408: Qa1-e5 после KS-2408 отсекается overlap; Nb5-c7 остаётся единственным creator', () => {
    // До KS-2408 в этой позиции было 2 creator-кандидата:
    //   - Nb5-c7 → c7 атакует a8(R)+e8(K), все цели новые.
    //   - Qa1-e5 → e5 атакует e8(K) и h8(R), но h8 уже была в
    //     targetsBefore[a1] (Qa1 атакует h8 по диагонали a1-h8).
    // По старому predicate (KS-2400) оба ходa creator'ы → strict-
    // uniqueness ломалась. По новому (KS-2408): Qa1-e5 — overlap,
    // не creator; Nb5-c7 единственный creator → valid.
    const r = findFork('r3k2r/8/8/1N6/8/8/8/Q3K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'b5', to: 'c7' },
    });
  });

  it('promotion-ход → отбрасывается (v1 без promotion)', () => {
    // Пешка a7 идёт a7-a8=N (Knight промоушен). Predicate v1
    // отбрасывает по `m.promotion`. В этой позиции вилки нет
    // независимо от promotion'а — итог 0 кандидатов корректен.
    const r = findFork('2k5/P7/8/8/r7/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('сторона на ходу = чёрные → forker чёрный', () => {
    // Чёрные на ходу. Белые король e1, ферзь a1, чёрный конь b4.
    // Nb4-c2: конь c2 атакует a1 (Q) + e1 (K) → fork. Других вилок
    // нет.
    const r = findFork('4k3/8/8/8/1n6/8/8/Q3K3 b - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'b4', to: 'c2' },
    });
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(findFork('garbage')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });

  // ─── KS-2406: safety-check форкера ────────────────────────────────

  it('KS-2406: Qxh7 даёт вилку короля и ладьи, но ферзь сам теряется → drop (unsafe-forker)', () => {
    // Acceptance из KS-2406: Qxh7 — единственный clean creator
    // (target's={g8, h8}, all new), но после хода ферзь на h7
    // атакован королём g8 без защитника. Простая v1 отбрасывает.
    const r = findFork('6kr/7p/8/8/8/3Q4/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toBe('unsafe-forker');
    }
  });

  it('KS-2406: Nf7 на безопасной клетке → candidate', () => {
    // Конь e5 → f7 атакует d8(Q) + h8(K). Конь не атакован ничем.
    const r = findFork('3q3k/8/8/4N3/8/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'e5', to: 'f7' },
    });
  });

  it('KS-2406: форкер атакован, но защищён равной фигурой → drop (простая v1)', () => {
    // Та же позиция Qxh7, но добавлен белый слон b1 (защитник по
    // диагонали b1-h7). Король g8 атакует, слон b1 защищает —
    // SEE-обмен ≈ потеря ферзя; простая v1 «есть атакующий → drop».
    const r = findFork('6kr/7p/8/8/8/8/8/1B2K2Q w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toBe('unsafe-forker');
    }
  });

  // ─── KS-2408: targetsBefore/targetsAfter по форкеру ──────────────

  it('KS-2408: ферзь продолжает атаковать ту же ладью + добавляет слона → drop overlap', () => {
    // Acceptance из KS-2408: ферзь e1 уже атакует ладью e8 по
    // e-вертикали (targetsBefore[e1]={e8}). Ход Qe4 атакует ту же
    // ладью e8 + слона a4 (targetsAfter[e4]={e8, a4}). Intersect={e8}
    // → overlap, drop.
    //
    // Расклад:
    //   - 8: чёрная ладья e8.
    //   - 7: чёрный король h7 (вне досягаемости с e1; не блокирует
    //     никаких форк-альтернатив).
    //   - 5: чёрная пешка h5 — блокирует Qh4 как альтернативу
    //     (чтобы только Qe4 имел |targets|≥2).
    //   - 4: чёрный слон a4.
    //   - 1: белые ферзь e1 + король h1.
    const r = findFork('4r3/7k/8/7p/b7/8/8/4Q2K w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toBe('overlap-with-previous-attacks');
    }
  });

  it('KS-2408: ферзь не атаковал ничего ценного с e1, Qe4 — clean fork → candidate', () => {
    // Зеркальный кейс к предыдущему: targetsBefore[e1]=∅ (нет
    // ценных на e-вертикали и диагоналях из e1). Ход Qe4 атакует
    // h7(N) по диагонали + a4(B) по 4-rank — обе цели новые.
    // Intersect=∅ → clean. Safety: на e4 нет атакующих чёрных.
    //
    // Расклад:
    //   - 8: чёрный король g8 (диагонали из e4 не проходят через g8).
    //   - 7: чёрный конь h7 (на диагонали из e4, конь не атакует e4).
    //   - 5: чёрная пешка h5 — блокирует Qh4 как альтернативу.
    //   - 4: чёрный слон a4.
    //   - 1: белые ферзь e1 + король h1.
    const r = findFork('6k1/7n/8/7p/b7/8/8/4Q2K w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'e1', to: 'e4' },
    });
  });

  it('KS-2408: конь атакует только пешку (не считается ценной), затем даёт вилку → candidate', () => {
    // Конь g1 «атакует» свою пешку e2 — но pawn не ценный, в
    // attacksBefore[g1] запись не появляется. Ход Ng1-f3 атакует
    // короля e1 + ладью h2 — 2 ценных, intersect=∅ → clean.
    //
    // Расклад:
    //   - 8: белый король a8 (далеко, чтобы не быть в шахе от Rh2).
    //   - 2: белая пешка e2 + чёрная ладья h2.
    //   - 1: чёрный король e1 + белый конь g1.
    const r = findFork('K7/8/8/8/8/8/4P2r/4k1N1 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'g1', to: 'f3' },
    });
  });

  it('KS-2408: slider-форкер — ладья продолжает атаковать ту же цель + добавляет вторую → drop overlap', () => {
    // Ладья a1 уже атакует чёрного короля a8 по a-вертикали
    // (attacksBefore[a1]={a8}). Ход Ra1-a4 продолжает атаковать
    // a8 + добавляет атаку на коня e4 по 4-rank
    // (targetsAfter[a4]={a8, e4}). Intersect={a8} → overlap, drop.
    //
    // Расклад:
    //   - 8: чёрный король a8.
    //   - 4: чёрный конь e4.
    //   - 1: белые ладья a1 + король h1.
    const r = findFork('k7/8/8/8/4n3/8/8/R6K w - - 0 1');
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toBe('overlap-with-previous-attacks');
    }
  });
});
