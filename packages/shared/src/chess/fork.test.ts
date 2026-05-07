/**
 * Unit-тесты `computeForkTargetsAfterMove` (KS-2455).
 */

import { describe, it, expect } from 'vitest';
import { computeForkTargetsAfterMove } from './fork.js';

describe('computeForkTargetsAfterMove', () => {
  it('конь на e5 атакует ферзя и ладью после хода (классическая вилка)', () => {
    // Ход N from c4 to e5 → атакует ферзя на g6 и ладью на c6.
    // chess.js должен выдавать атаки. Цвет на ходу — белый.
    const fen = '4k3/8/2r3q1/8/2N5/8/8/4K3 w - - 0 1';
    const r = computeForkTargetsAfterMove(fen, { from: 'c4', to: 'e5' });
    expect(r).not.toBeNull();
    expect(r!.forkerSq).toBe('e5');
    // Конь с e5 атакует c6 (ладья), g6 (ферзь), c4, d3, f3, d7, g4, f7.
    // Из них ценные (≥3) — ладья и ферзь.
    expect(r!.targets.sort()).toEqual(['c6', 'g6'].sort());
  });

  it('ход без вилки → null', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const r = computeForkTargetsAfterMove(fen, { from: 'e2', to: 'e4' });
    expect(r).toBeNull();
  });

  it('некорректный ход → null', () => {
    const fen = '4k3/8/2r3q1/8/2N5/8/8/4K3 w - - 0 1';
    const r = computeForkTargetsAfterMove(fen, { from: 'a1', to: 'a8' });
    expect(r).toBeNull();
  });

  it('overlap-фильтр: фигура продолжает атаковать ту же цель — не вилка', () => {
    // До хода ферзь d1 уже атакует чёрную ладью d8 по линии d.
    // Передвигаем ферзя на d4 — продолжает атаковать ту же ладью.
    // Атак ≥2 нет (только d8), вилки не возникает — null.
    const fen = '3r2k1/8/8/8/8/8/8/3Q3K w - - 0 1';
    const r = computeForkTargetsAfterMove(fen, { from: 'd1', to: 'd4' });
    expect(r).toBeNull();
  });

  it('некорректный FEN → null', () => {
    const r = computeForkTargetsAfterMove('not-a-fen', { from: 'e2', to: 'e4' });
    expect(r).toBeNull();
  });
});
