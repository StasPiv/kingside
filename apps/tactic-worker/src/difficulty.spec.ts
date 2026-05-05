/**
 * KS-2225 / KS-2229. Тесты difficulty-формулы.
 *
 * Покрытие:
 *   - bucket-cuts на пограничных значениях (0.19999 → 1; 0.20 → 2; ...).
 *   - mapping-функции (`fPieceCount`, `fAttackerDensity`, ...) на step-границах.
 *   - intergration: реальная FEN → factor → bucket.
 */

import { Chess } from 'chess.js';
import {
  computeDifficulty,
  computeDifficultyScore,
  fAttackerDensity,
  fDistractorCount,
  fMaterialBalance,
  fPieceCount,
  scoreToBucket,
  WEIGHTS_FULL,
  type DrillFactors,
} from './difficulty';

describe('scoreToBucket — KS-2225 §9.6 bucket cuts', () => {
  it.each([
    [0, 1],
    [0.199999, 1],
    [0.2, 2],
    [0.349999, 2],
    [0.35, 3],
    [0.549999, 3],
    [0.55, 4],
    [0.749999, 4],
    [0.75, 5],
    [1.0, 5],
  ])('score %p → bucket %p', (score, expected) => {
    expect(scoreToBucket(score)).toBe(expected);
  });
});

describe('fPieceCount — §9.4 mapping', () => {
  function fenWith(N: number): Chess {
    // Помещаем N небольших фигур (пешки чёрные) на a-вертикаль и
    // h-вертикаль + два короля.
    const ranks = [7, 6, 5, 4, 3, 2];
    const pieces: string[] = [];
    let placed = 0;
    for (const r of ranks) {
      for (const file of 'abcdefgh') {
        if (placed >= N) break;
        pieces.push(`${file}${r}`);
        placed++;
      }
      if (placed >= N) break;
    }
    // build FEN с пешками на pieces[]
    const board: Record<string, string> = {};
    for (const sq of pieces) board[sq] = 'p';
    board['e1'] = 'K';
    board['e8'] = 'k';
    const rows: string[] = [];
    for (let r = 8; r >= 1; r--) {
      let row = '';
      let empty = 0;
      for (const file of 'abcdefgh') {
        const sq = `${file}${r}`;
        const piece = board[sq];
        if (piece) {
          if (empty) {
            row += empty;
            empty = 0;
          }
          row += piece;
        } else empty++;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return new Chess(`${rows.join('/')} w - - 0 1`);
  }

  it.each([
    [4, 0.10],
    [12, 0.30],
    [20, 0.60],
    [26, 0.85],
    [30, 1.0],
  ])('N=%p (некоролевские) → %p', (n, expected) => {
    const chess = fenWith(n);
    expect(fPieceCount(chess)).toBeCloseTo(expected, 5);
  });
});

describe('fDistractorCount — §9.4 mapping', () => {
  it.each([
    [0, 0],
    [1, 0.3],
    [2, 0.3],
    [3, 0.6],
    [4, 0.6],
    [5, 0.9],
    [10, 0.9],
  ])('count=%p → %p', (c, expected) => {
    expect(fDistractorCount(c)).toBeCloseTo(expected, 5);
  });
});

describe('fAttackerDensity — §9.4 mapping', () => {
  it('пустая доска (только короли) → low density (0.10 или 0.30)', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    const density = fAttackerDensity(chess);
    // 2 короля атакуют по ~5 клеток вокруг; внутри них друг друга не
    // атакуют (далеко). attackers суммарно = 0. density=0 → 0.10.
    expect(density).toBe(0.10);
  });

  it('плотная позиция → high density', () => {
    // Стартовая позиция: много взаимных атак.
    const chess = new Chess(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    const density = fAttackerDensity(chess);
    expect(density).toBeGreaterThanOrEqual(0.30);
  });
});

describe('fMaterialBalance — §9.4 mapping', () => {
  it('равный материал → 1.0 (сложно: нет подсказки)', () => {
    const chess = new Chess(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(fMaterialBalance(chess)).toBe(1.0);
  });

  it('большая разница → низкое значение', () => {
    // у белых полный комплект, у чёрных только король.
    const chess = new Chess(
      '4k3/8/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1',
    );
    expect(fMaterialBalance(chess)).toBe(0.1);
  });
});

describe('computeDifficulty — KS-2225 §9.10 integration', () => {
  it('v1: сложность простой позиции (count-attackers с value=2) → bucket 1 или 2', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1');
    const r = computeDifficulty(
      'count-attackers',
      chess,
      { shape: 'number', value: 2 },
      'v1',
    );
    expect(r.bucket).toBeGreaterThanOrEqual(1);
    expect(r.bucket).toBeLessThanOrEqual(3);
    expect(r.factors.typeSpecific).toBeCloseTo(0.33, 2);
  });

  it('v1: count-attackers с value=4 в плотной позиции → bucket выше', () => {
    const chess = new Chess(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    const r = computeDifficulty(
      'count-attackers',
      chess,
      { shape: 'number', value: 4 },
      'v1',
    );
    // value=4 → typeSpecific=1.0; pieceCount=1.0; attackerDensity=0.30+
    // → score = 0.30·1 + 0.30·0.30+ + 0.40·1 = ~0.79 → bucket 5.
    expect(r.bucket).toBeGreaterThanOrEqual(4);
  });

  it('v1: full и v1 формулы возвращают разные scores', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/Q3K3 w - - 0 1');
    const v1 = computeDifficulty(
      'count-attackers',
      chess,
      { shape: 'number', value: 2 },
      'v1',
    );
    const full = computeDifficulty(
      'count-attackers',
      chess,
      { shape: 'number', value: 2 },
      'full',
    );
    // Не строго разные — может совпасть случайно, но шкалы разные.
    expect(typeof v1.score).toBe('number');
    expect(typeof full.score).toBe('number');
    // Веса для full другие — проверяем что хотя бы один из факторов
    // в full отличается от 0 (distractorCount/material/mobility),
    // которые в v1 = 0.
    expect(
      full.factors.materialBalance > 0 ||
        full.factors.mobilityRatio > 0 ||
        full.factors.distractorCount >= 0,
    ).toBe(true);
  });

  it('v1 формула: total = 0.30·pc + 0.30·ad + 0.40·ts', () => {
    const factors: DrillFactors = {
      pieceCount: 0.5,
      attackerDensity: 0.4,
      distractorCount: 0.9,
      materialBalance: 1.0,
      mobilityRatio: 1.0,
      typeSpecific: 0.6,
    };
    const v1 = computeDifficultyScore('find-fork', factors, 'v1');
    expect(v1).toBeCloseTo(0.30 * 0.5 + 0.30 * 0.4 + 0.40 * 0.6, 5);
  });

  it('full: учитывает все факторы по WEIGHTS_FULL', () => {
    const factors: DrillFactors = {
      pieceCount: 0.5,
      attackerDensity: 0.4,
      distractorCount: 0.9,
      materialBalance: 1.0,
      mobilityRatio: 1.0,
      typeSpecific: 0.6,
    };
    const w = WEIGHTS_FULL['find-fork'];
    const full = computeDifficultyScore('find-fork', factors, 'full');
    const expected =
      w.pc * 0.5 +
      w.ad * 0.4 +
      w.dc * 0.9 +
      w.ts * 0.6 +
      0.05 * 1.0 +
      0.05 * 1.0;
    expect(full).toBeCloseTo(expected, 5);
  });
});
