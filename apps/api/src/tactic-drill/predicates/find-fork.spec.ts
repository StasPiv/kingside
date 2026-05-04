/**
 * KS-2227 / KS-2399 / KS-2400 — `find-fork` тесты.
 *
 * Семантика после KS-2400: shape='move'. Drill ищет ход,
 * **создающий новую вилку** — нашу фигуру, атакующую ≥2 ценных
 * фигур противника (snapshot before/after по аналогии с
 * `find-undefended-attack`, KS-2372).
 */

import { findFork } from './find-fork';

describe('findFork — KS-2400 (shape="move")', () => {
  it('Nb5-c7: новая вилка короля e8 + ладьи a8 → {from:b5, to:c7}', () => {
    // Конь b5 на ходу. Единственный ход, дающий новую вилку — Nc7.
    // forksBefore: ничего (b5 не атакует ценных; король e1 не fork).
    // После Nc7: c7 атакует a8(R) и e8(K) → fork.
    const r = findFork('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'move', from: 'b5', to: 'c7' },
    });
  });

  it('конь уже на c7 (вилка стоит до хода) → drop', () => {
    // forksBefore = {c7}. После любого хода либо c7 уходит из forks,
    // либо новых клеток не появляется → diff пуст для всех ходов.
    const r = findFork('r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('одна атакуемая ценная фигура → не вилка', () => {
    // Ход коня b5-d6: атакует только e8 (K). c8 пусто. Не fork.
    // Никакой другой ход тоже не делает вилку (нет второй цели).
    const r = findFork('4k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('пешечные цели (value=1) не считаются → drop', () => {
    // Конь c3 после Nb5 атаковал бы пешки a7/c7 — но pawn=1 < 3,
    // не «ценные». Никакой ход не делает вилку из ценных целей.
    const r = findFork('4k3/p1p5/8/8/8/2N5/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('два разных хода создают новую вилку → drop (strict-uniqueness)', () => {
    // Кандидаты:
    //   - Nb5-c7  → c7 атакует a8(R)+e8(K), вилка.
    //   - Qa1-e5  → e5 атакует e8(K) по e-вертикали + h8(R) по диагонали.
    // Оба — новые клетки в forksAfter; до хода forksBefore содержит {a1}
    // (Qa1 атакует a8 и h8 по a-вертикали и диагонали соответственно).
    // strict-uniqueness нарушена.
    const r = findFork('r3k2r/8/8/1N6/8/8/8/Q3K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('promotion-ход → отбрасывается (v1 без promotion)', () => {
    // Пешка a7 идёт a7-a8=N (Knight промоушен). Если бы фишка a8
    // делала вилку — predicate v1 всё равно отбросит из-за `m.promotion`.
    // Здесь подберём такую позицию: чёрные король c8 и ладья a4. Белая
    // пешка a7 → a8=N (поддержка по диагонали). a8 — не клетка
    // forks: конь на a8 атакует b6, c7 — пусто. Тут вилки нет, но
    // тест демонстрирует: promotion-моusли просто игнорируется
    // циклом, и итог `0 кандидатов` корректен.
    const r = findFork('2k5/P7/8/8/r7/8/8/4K3 w - - 0 1');
    expect(r.valid).toBe(false);
  });

  it('сторона на ходу = чёрные → forker чёрный', () => {
    // Чёрные на ходу. Белые король e1, ферзь a1, чёрный конь b4.
    // Nb4-c2: конь c2 атакует a1 (Q) + e1 (K) → fork. Других вилок
    // нет (b4 до хода — никаких ценных в его клетках буквой "Г").
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
});
