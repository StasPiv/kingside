import { describe, it, expect } from 'vitest';

import {
  getBracketClasses,
  getMoveClasses,
  type BracketItem,
  type ProcessedMove,
} from './ChessMoveProcessing';

/**
 * KS-2275 — `getBracketClasses` теперь содержит `variation-level-N`,
 * чтобы layout (CSS) мог окрашивать `(` и `)` в `--c-subline-N`
 * (тот же level-токен, что и у move-item внутри скобок).
 *
 * Также фиксируем существующий контракт `getMoveClasses` (clamp до 4).
 */

function makeBracket(
  bracketType: 'open' | 'close',
  level: number,
): BracketItem {
  return {
    type: 'bracket',
    bracketType,
    level,
    path: [],
    variationIndex: 0,
    parentMoveIndex: 1,
  };
}

function makeMove(level: number, isCurrent = false): ProcessedMove {
  return {
    globalIndex: 1,
    display: '1.e4',
    isCurrent,
    isVariation: level > 0,
    level,
    path: [],
    originalMove: undefined as unknown as ProcessedMove['originalMove'],
  };
}

describe('getBracketClasses (KS-2275)', () => {
  it('open bracket level=0 → variation-level-1 (внутренние ходы тоже level=1)', () => {
    const cls = getBracketClasses(makeBracket('open', 0));
    expect(cls).toContain('variation-bracket');
    expect(cls).toContain('variation-bracket-open');
    expect(cls).toContain('variation-level-1');
  });

  it('close bracket level=2 → variation-level-3 (level + 1)', () => {
    const cls = getBracketClasses(makeBracket('close', 2));
    expect(cls).toContain('variation-bracket-close');
    expect(cls).toContain('variation-level-3');
  });

  it('clamp до 4: level=10 → variation-level-4', () => {
    const cls = getBracketClasses(makeBracket('open', 10));
    expect(cls).toContain('variation-level-4');
    expect(cls).not.toContain('variation-level-11');
  });

  it('open и close одного уровня дают одинаковый level-класс', () => {
    const open = getBracketClasses(makeBracket('open', 1));
    const close = getBracketClasses(makeBracket('close', 1));
    // У обоих — variation-level-2 (level + 1).
    expect(open).toContain('variation-level-2');
    expect(close).toContain('variation-level-2');
  });
});

describe('getMoveClasses — регрессия контракта', () => {
  it('main-line move (level=0) → "move-item" без variation-level', () => {
    const cls = getMoveClasses(makeMove(0));
    expect(cls).toBe('move-item');
  });

  it('variation move level=2 → variation-level-2 + variation-move', () => {
    const cls = getMoveClasses(makeMove(2));
    expect(cls).toContain('move-item');
    expect(cls).toContain('variation-move');
    expect(cls).toContain('variation-level-2');
  });

  it('current + variation: оба класса', () => {
    const cls = getMoveClasses(makeMove(1, true));
    expect(cls).toContain('current');
    expect(cls).toContain('variation-move');
    expect(cls).toContain('variation-level-1');
  });

  it('clamp до 4: move level=7 → variation-level-4', () => {
    const cls = getMoveClasses(makeMove(7));
    expect(cls).toContain('variation-level-4');
  });
});
