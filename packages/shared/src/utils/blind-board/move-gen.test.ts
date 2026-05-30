/**
 * KS-3439 / ADR-088 §11 (S2) — unit-тесты blind-board move-generator.
 */
import { describe, it, expect } from 'vitest';
import {
  geometricMoves,
  attacks,
  findUniqueTargetMoves,
  parseSquare,
  makeSquare,
} from './move-gen.js';
import type {
  BlindBoardPiece,
  BlindBoardSquare,
} from '../../types/api-contracts.js';

const p = (square: BlindBoardSquare, type: 'Q' | 'R' | 'B' | 'N'): BlindBoardPiece => ({
  square,
  type,
});

describe('parseSquare / makeSquare', () => {
  it('a1 ↔ (0,0); h8 ↔ (7,7)', () => {
    expect(parseSquare('a1')).toEqual([0, 0]);
    expect(parseSquare('h8')).toEqual([7, 7]);
    expect(makeSquare(0, 0)).toBe('a1');
    expect(makeSquare(7, 7)).toBe('h8');
  });
  it('makeSquare вне доски → null', () => {
    expect(makeSquare(-1, 0)).toBeNull();
    expect(makeSquare(8, 0)).toBeNull();
    expect(makeSquare(0, 8)).toBeNull();
  });
});

describe('geometricMoves — конь (N)', () => {
  it('конь в центре → 8 прыжков', () => {
    const piece = p('d4', 'N');
    const moves = geometricMoves(piece, [piece]);
    expect(new Set(moves)).toEqual(
      new Set(['e6', 'f5', 'f3', 'e2', 'c2', 'b3', 'b5', 'c6']),
    );
  });
  it('конь у угла a1 → 2 прыжка', () => {
    expect(new Set(geometricMoves(p('a1', 'N'), [p('a1', 'N')]))).toEqual(
      new Set(['b3', 'c2']),
    );
  });
  it('конь прыгает через фигуры, но не может встать на занятую', () => {
    const N = p('d4', 'N');
    const pos = [N, p('e6', 'Q')]; // занят один из прыжковых
    const moves = new Set(geometricMoves(N, pos));
    expect(moves.has('e6')).toBe(false); // занят
    expect(moves.has('f5')).toBe(true); // свободный — конь «прыгнул через»
    expect(moves.size).toBe(7);
  });
});

describe('geometricMoves — ладья (R)', () => {
  it('ладья в углу a1 → 14 клеток (7 по вертикали + 7 по горизонтали)', () => {
    const R = p('a1', 'R');
    const moves = geometricMoves(R, [R]);
    expect(moves.length).toBe(14);
  });
  it('ладья луч обрывается ДО своей фигуры (не встаёт на занятую)', () => {
    const R = p('a1', 'R');
    const blocker = p('a4', 'Q');
    const moves = new Set(geometricMoves(R, [R, blocker]));
    expect(moves.has('a2')).toBe(true);
    expect(moves.has('a3')).toBe(true);
    expect(moves.has('a4')).toBe(false); // занята
    expect(moves.has('a5')).toBe(false); // за препятствием
  });
});

describe('geometricMoves — слон (B) / ферзь (Q)', () => {
  it('слон d4 без препятствий → 13 диагональных клеток', () => {
    const B = p('d4', 'B');
    const moves = geometricMoves(B, [B]);
    expect(moves.length).toBe(13);
    expect(new Set(moves).has('a1')).toBe(true);
    expect(new Set(moves).has('h8')).toBe(true);
  });
  it('ферзь d4 без препятствий → 27 клеток (14 R + 13 B)', () => {
    const Q = p('d4', 'Q');
    expect(geometricMoves(Q, [Q]).length).toBe(27);
  });
});

describe('attacks — включает клетку препятствия', () => {
  it('ладья на a1 с препятствием на a4 → атакует a2,a3,a4', () => {
    const R = p('a1', 'R');
    const blocker = p('a4', 'Q');
    const atk = attacks(R, [R, blocker]);
    expect(atk.has('a2')).toBe(true);
    expect(atk.has('a3')).toBe(true);
    expect(atk.has('a4')).toBe(true); // клетка препятствия — атакована
    expect(atk.has('a5')).toBe(false); // за препятствием
  });
  it('конь атакует все 8 прыжков независимо от занятости', () => {
    const N = p('d4', 'N');
    const pos = [N, p('e6', 'Q')]; // занятая прыжковая
    const atk = attacks(N, pos);
    expect(atk.has('e6')).toBe(true); // конь атакует через занятость
    expect(atk.size).toBe(8);
  });
  it('слон c1 без препятствий — атакует диагональ до края', () => {
    const B = p('c1', 'B');
    const atk = attacks(B, [B]);
    expect(atk.has('h6')).toBe(true);
    expect(atk.has('a3')).toBe(true);
  });
});

describe('findUniqueTargetMoves (§3 алгоритм)', () => {
  it('кандидат: после хода ровно ОДНА фигура вовлечена', () => {
    // Конь d4. Q на e6 (его прыжок). R на a8 (далеко, не задействована).
    // Если N идёт на c6 — он атакует e7,d8,b8,a7,a5,b4,d4,e5 (e7?
    // напомню KNIGHT_OFFSETS). Проще: возьмём ход N c2 → e1,e3,c4,d4,
    // f1,g3 — none from set {e6,a8}. |involved|=0.
    // Ход N e6 запрещён (там Q). Ход N e2 → атакует {c1,d4,f4,g1,g3,
    // c3, f4} — не атакует ни Q@e6 ни R@a8 → 0.
    // Простой кейс: B на a1, Q на h8 (вне диагонали). N на c1.
    // N идёт на b3 → атакует {a1,c1(пусто),a5,c5,d2,d4} — никого не
    // задевает. Кандидатов 0.
    //
    // Чёткий кейс: R на a1, Q на h1. Ход R: a1→a8 (после хода R на a8).
    // R@a8 атакует луч до Q? Нет — Q на h1, R@a8 не на одной горизонтали.
    // R@a8 атакует h8 — пусто. 0 involved.
    // R на a1 → e1: атакует [b1..h1] до Q@h1 (включая f1,g1,h1) → Q вовлечена.
    // других фигур нет → |involved|=1 ✓.
    const R = p('a1', 'R');
    const Q = p('h1', 'Q');
    const pos = [R, Q];
    const cand = findUniqueTargetMoves(pos, 'a1');
    // R может ходить по 1-й горизонтали (b1..g1, h1 занята) и a-файлу.
    // На b1..g1 → R атакует Q@h1 (луч до неё) → involved={Q}, |1|.
    // Также Q атакует to (для каждой to из 1-й горизонтали).
    const tos = cand.map((c) => c.to);
    expect(tos).toContain('b1');
    expect(tos).toContain('g1');
    // a2..a7: R@aX не на линии с Q@h1; Q@h1 диагональ h1-a8 → не атакует
    // a2..a7. involved=0 → не кандидаты.
    expect(tos).not.toContain('a2');
    expect(tos).not.toContain('a7');
    // a8: Q@h1 атакует a8 по диагонали h1-a8 (h1,g2,f3,e4,d5,c6,b7,a8)
    // → involved={Q} → КАНДИДАТ.
    expect(tos).toContain('a8');
    // Каждый кандидат — target=Q.
    for (const c of cand) {
      expect(c.target.type).toBe('Q');
      expect(c.target.square).toBe('h1');
    }
  });

  it('|involved|=0 (никого не задевает) → не кандидат', () => {
    // Изолированный конь на d4, единственный.
    const N = p('d4', 'N');
    const isolated = p('h8', 'B'); // на диагонали но конь не задевает
    const pos = [N, isolated];
    // Конь ходит — не атакует h8, h8 не атакует конь после хода.
    const cand = findUniqueTargetMoves(pos, 'd4');
    // Все ходы коня → нет вовлечения h8 (он на диагонали, не в радиусе).
    // Но N после хода — слон h8 может атаковать клетку приземления, если
    // та на диагонали a1-h8. d4→c6 (нет диаг с h8), b5(нет), f5(нет),
    // e6(на диагонали! a2-...-h8? нет, a2-g8. h8 диагонали: a1-h8, h1-a8).
    // На диагонали a1-h8: a1,b2,c3,d4,e5,f6,g7,h8. Если N идёт на e5
    // или другую клетку этой диагонали — B@h8 атакует to.
    // Но e5 для коня с d4 не доступен (Knight moves: c2,e2,b3,f3,b5,f5,
    // c6,e6). e5 не в списке. Также 0 на диагонали из этих.
    // Так что involved=0 для всех ходов.
    expect(cand.length).toBe(0);
  });

  it('|involved|=2 (несколько вовлечено) → ход отсеян', () => {
    // R@a1, две Q на h1 и a8. R→a2..a7 → атакует Q@a8 ✓ и R сам атакован
    // снизу? Нет — Q@h1 атакует a1 (по диагонали? нет, h1 → диагонали:
    // h2..a-сторона h1-a8 (g2,f3,e4,d5,c6,b7,a8). Так что Q@h1 атакует
    // a8 по диагонали. Но Q@h1 атакует НАШУ Q@a8? Да! Но они — others.
    // Для ХОДА R→a2: R на a2, Q@h1, Q@a8.
    // movedAtk = R-атаки с a2: {a1,a3..a8,b2..h2}. → атакует Q@a8 ✓, Q@h1 ✓ (h2 в R-атаках).
    // Wait — Q@h1 на клетке h1, R@a2 атакует горизонталь 2: b2,c2..h2. h1 не в этом.
    // Тогда R@a2 атакует только Q@a8 (по a-файлу). Q@h1 атакует a2? горизонт h1: g1..a1 (без a2). a8 диагональ. → не атакует a2.
    // Q@a8 атакует a2 ✓ (a-файл). → involved={Q@a8} ✓.
    // Но также Q@h1 ↔ Q@a8 атакуют друг друга (диагональ h1-a8) — это НЕ задействует R, не входит в involved.
    // Так что |involved|=1.
    //
    // Чтобы получить |involved|=2: R@d4, Q на d1 и Q на d8. R→d5..d7 → атакует обоих Q (по d-файлу).
    // R→d5: R атакует {d1..d4,d6..d8,a5..h5} → Q@d1 ✓, Q@d8 ✓ → |involved|=2.
    const R = p('d4', 'R');
    const Q1 = p('d1', 'Q');
    const Q2 = p('d8', 'Q');
    const pos = [R, Q1, Q2];
    const cand = findUniqueTargetMoves(pos, 'd4');
    // Ход d5 — оба Q вовлечены → отсеян.
    expect(cand.map((c) => c.to)).not.toContain('d5');
    expect(cand.map((c) => c.to)).not.toContain('d6');
    expect(cand.map((c) => c.to)).not.toContain('d7');
  });

  it('targetPieceSquare отсутствует в позиции → пустой результат', () => {
    expect(findUniqueTargetMoves([p('a1', 'R')], 'h8')).toEqual([]);
  });
});
