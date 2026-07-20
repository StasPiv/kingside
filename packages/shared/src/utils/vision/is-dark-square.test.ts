/**
 * KS-4981 / ADR-167 §1 — unit-тесты цвета клетки.
 */
import { describe, it, expect } from 'vitest';
import type { BlindBoardSquare } from '../../types/api-contracts.js';
import { isDarkSquare, squareColor } from './is-dark-square.js';

describe('isDarkSquare (ADR-167 §1)', () => {
  it('a1 тёмная, h1 светлая (опорные точки ADR)', () => {
    expect(isDarkSquare('a1')).toBe(true);
    expect(isDarkSquare('h1')).toBe(false);
  });

  it('a8 светлая, h8 тёмная (углы)', () => {
    expect(isDarkSquare('a8')).toBe(false);
    expect(isDarkSquare('h8')).toBe(true);
  });

  it('соседние по горизонтали клетки — разного цвета', () => {
    for (const rank of '12345678') {
      let prev: boolean | null = null;
      for (const file of 'abcdefgh') {
        const cur = isDarkSquare(`${file}${rank}` as BlindBoardSquare);
        if (prev !== null) expect(cur).toBe(!prev);
        prev = cur;
      }
    }
  });

  it('ровно 32 тёмных клетки на доске', () => {
    let dark = 0;
    for (const file of 'abcdefgh') {
      for (const rank of '12345678') {
        if (isDarkSquare(`${file}${rank}` as BlindBoardSquare)) dark++;
      }
    }
    expect(dark).toBe(32);
  });

  it('squareColor согласован с isDarkSquare', () => {
    expect(squareColor('a1')).toBe('dark');
    expect(squareColor('h1')).toBe('light');
  });
});
