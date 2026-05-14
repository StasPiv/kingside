/**
 * KS-3041: тесты `clampMultiPvToLegalMoves`. Хук `useStockfish`
 * целиком не тестируется (Web Worker + WASM), а его новая ветка
 * клемпы — чистая функция, проверяется юнитом.
 */

import { describe, it, expect } from 'vitest';
import { clampMultiPvToLegalMoves } from './useStockfish';

describe('clampMultiPvToLegalMoves (KS-3041)', () => {
  it('FEN из жалобы (2 легальных ответа на шах) — multipv=3 → 2', () => {
    // Белые в шахе от ладьи d1; легальные ответы: Re1 (блок) и Kh2.
    // Все остальные клетки короля либо заняты, либо под боем.
    const fen = '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51';
    expect(clampMultiPvToLegalMoves(fen, 3)).toBe(2);
  });

  it('обычная позиция (≥3 легальных хода) — multipv=3 → 3 (без изменений)', () => {
    // Стартовая позиция — 20 легальных ходов у белых.
    expect(
      clampMultiPvToLegalMoves(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        3,
      ),
    ).toBe(3);
    expect(
      clampMultiPvToLegalMoves(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        5,
      ),
    ).toBe(5);
  });

  it('multipv=1 не меняется даже в матовой позиции', () => {
    // Stalemate в фигурном эндшпиле: чёрный король в углу, белые
    // лишают всех ходов без шаха. Здесь 0 легальных ходов — функция
    // отдаёт 1 (движок сам сразу пришлёт bestmove).
    const stalemate = '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1';
    expect(clampMultiPvToLegalMoves(stalemate, 1)).toBe(1);
    expect(clampMultiPvToLegalMoves(stalemate, 3)).toBe(1);
  });

  it('multipv < 1 нормируется к 1', () => {
    expect(clampMultiPvToLegalMoves('8/8/8/8/8/8/8/k1K5 w - - 0 1', 0)).toBe(1);
    expect(clampMultiPvToLegalMoves('8/8/8/8/8/8/8/k1K5 w - - 0 1', -5)).toBe(1);
  });

  it('FEN невалидный — отдаём requested (>=1) и не падаем', () => {
    expect(clampMultiPvToLegalMoves('garbage', 3)).toBe(3);
    expect(clampMultiPvToLegalMoves('', 5)).toBe(5);
  });

  it('non-integer multipv: округление вниз через Math.floor', () => {
    const startFen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(clampMultiPvToLegalMoves(startFen, 3.9)).toBe(3);
    expect(clampMultiPvToLegalMoves(startFen, 2.1)).toBe(2);
  });
});
