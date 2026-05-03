/**
 * KS-2227 — `count-attackers` тесты.
 */

import {
  countAttackers,
  findCountAttackersCandidates,
} from './count-attackers';

describe('countAttackers — KS-2227', () => {
  it('1 атакующий → answer.value=1', () => {
    // Белый ферзь d1 атакует d8 (вертикаль).
    const r = countAttackers('3k4/8/8/8/8/8/8/3QK3 w - - 0 1', 'd8', 'w');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'number', value: 1 },
    });
  });

  it('3 атакующих → answer.value=3', () => {
    // Кони d2 и g3 + ладья e1 — все атакуют e4.
    const r = countAttackers('4k3/8/8/8/8/6N1/3N4/4RK2 w - - 0 1', 'e4', 'w');
    expect(r).toEqual({
      valid: true,
      answer: { shape: 'number', value: 3 },
    });
  });

  it('5 атакующих → drop (вне диапазона 1..4)', () => {
    // 4 коня d2/f2/g3/c3 атакуют e4 + ладья e1 → 5 атакующих.
    const r = countAttackers('4k3/8/8/8/8/2N3N1/3N1N2/4RK2 w - - 0 1', 'e4', 'w');
    expect(r.valid).toBe(false);
  });

  it('0 атакующих → drop', () => {
    const r = countAttackers('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'e4', 'w');
    expect(r).toEqual({
      valid: false,
      reason: 'attackers count 0 outside [1,4]',
    });
  });

  it('сторона атакующих важна: одна и та же клетка может иметь разный count для w/b', () => {
    // Белый конь c3 и чёрный конь g6 — оба атакуют e4 со своих сторон.
    // attackers(e4, 'w') = [c3]; attackers(e4, 'b') = [g6].
    const fen = '4k3/8/5n2/8/8/2N5/8/4K3 w - - 0 1';
    expect(countAttackers(fen, 'e4', 'w')).toEqual({
      valid: true,
      answer: { shape: 'number', value: 1 },
    });
    expect(countAttackers(fen, 'e4', 'b')).toEqual({
      valid: true,
      answer: { shape: 'number', value: 1 },
    });
  });

  it('невалидный FEN → invalid_fen', () => {
    expect(countAttackers('not-a-fen', 'e4', 'w')).toEqual({
      valid: false,
      reason: 'invalid_fen',
    });
  });
});

describe('findCountAttackersCandidates — KS-2227', () => {
  it('возвращает все валидные (square, color)-пары', () => {
    // Простая позиция с одной парой атак: белый ферзь d1 → d8 (1 attacker).
    const cands = findCountAttackersCandidates('3k4/8/8/8/8/8/8/3QK3 w - - 0 1');
    // Среди кандидатов должна быть пара (d8, w) с value=1.
    const found = cands.find(
      (c) => c.targetSquare === 'd8' && c.attackerColor === 'w',
    );
    expect(found).toBeDefined();
    expect(found?.answer.value).toBe(1);
  });

  it('пустая доска (только короли) → нет кандидатов с count > 0 за исключением короля-короля', () => {
    const cands = findCountAttackersCandidates('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    // На доске только короли. Каждый король атакует 8 (или меньше)
    // соседних клеток → есть валидные кандидаты.
    expect(cands.length).toBeGreaterThan(0);
    // Все value ∈ [1, 4]
    for (const c of cands) {
      expect(c.answer.value).toBeGreaterThanOrEqual(1);
      expect(c.answer.value).toBeLessThanOrEqual(4);
    }
  });

  it('невалидный FEN → пустой массив', () => {
    expect(findCountAttackersCandidates('garbage')).toEqual([]);
  });
});
