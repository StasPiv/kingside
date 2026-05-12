import { describe, it, expect } from 'vitest';

import {
  getBracketClasses,
  getMoveClasses,
  isBracketItem,
  isProcessedMove,
  processMoveHierarchy,
  type BracketItem,
  type ProcessedMove,
} from './ChessMoveProcessing';
import { parseAnnotatedPgn } from './PgnDeserializer';
import type { ChessMove, VariationColor } from '../types';

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

function makeMove(
  level: number,
  isCurrent = false,
  variationColor?: VariationColor,
): ProcessedMove {
  return {
    globalIndex: 1,
    display: '1.e4',
    isCurrent,
    isVariation: level > 0,
    level,
    path: [],
    originalMove: undefined as unknown as ProcessedMove['originalMove'],
    variationColor,
    san: 'e4',
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

/**
 * KS-2288 (ADR-038 §6, VC E2) — пользовательский цвет вариации.
 *
 * Покрытие:
 *  - getMoveClasses: variationColor=green → variation-color-green,
 *    variation-level-N НЕ добавляется.
 *  - getMoveClasses: без variationColor → fallback на variation-level-N.
 *  - getMoveClasses: variationColor для всех 4 цветов.
 *  - getBracketClasses: тот же override.
 *  - processMoveHierarchy: цвет с root.variationColor наследуется
 *    всеми ходами и скобками вариации (включая глубже).
 *  - processMoveHierarchy: подвариация со СВОИМ root.variationColor
 *    переопределяет наследуемый.
 *  - processMoveHierarchy: main-line move БЕЗ variationColor (даже
 *    если в move.variationColor что-то — игнорируется на main-line).
 *  - processMoveHierarchy: вариация без variationColor — undefined у
 *    всех её ходов (auto-coloring fallback).
 */
describe('getMoveClasses (KS-2288 variationColor override)', () => {
  it('variationColor=green → variation-color-green, БЕЗ variation-level-N', () => {
    const cls = getMoveClasses(makeMove(2, false, 'green'));
    expect(cls).toContain('variation-color-green');
    expect(cls).toContain('variation-move');
    // Override: variation-level-2 НЕ добавляется.
    expect(cls).not.toMatch(/variation-level-/);
  });

  it.each<VariationColor>(['red', 'green', 'blue', 'yellow'])(
    'variationColor=%s → variation-color-%s',
    (color) => {
      const cls = getMoveClasses(makeMove(1, false, color));
      expect(cls).toContain(`variation-color-${color}`);
    },
  );

  it('current + variationColor: оба класса (variation-color-X + current)', () => {
    const cls = getMoveClasses(makeMove(1, true, 'red'));
    expect(cls).toContain('current');
    expect(cls).toContain('variation-color-red');
    expect(cls).not.toMatch(/variation-level-/);
  });

  it('без variationColor: fallback на variation-level-N (поведение KS-2275)', () => {
    const cls = getMoveClasses(makeMove(2, false));
    expect(cls).toContain('variation-level-2');
    expect(cls).not.toMatch(/variation-color-/);
  });
});

describe('getBracketClasses (KS-2288 variationColor override)', () => {
  it('variationColor=blue → variation-color-blue, БЕЗ variation-level-N', () => {
    const bracket: BracketItem = {
      ...makeBracket('open', 0),
      variationColor: 'blue',
    };
    const cls = getBracketClasses(bracket);
    expect(cls).toContain('variation-bracket');
    expect(cls).toContain('variation-bracket-open');
    expect(cls).toContain('variation-color-blue');
    expect(cls).not.toMatch(/variation-level-/);
  });

  it('без variationColor: fallback на variation-level-N (поведение KS-2275)', () => {
    const cls = getBracketClasses(makeBracket('close', 1));
    expect(cls).toContain('variation-level-2');
    expect(cls).not.toMatch(/variation-color-/);
  });

  it.each<VariationColor>(['red', 'green', 'blue', 'yellow'])(
    'все 4 цвета: variationColor=%s → variation-color-%s',
    (color) => {
      const cls = getBracketClasses({
        ...makeBracket('open', 0),
        variationColor: color,
      });
      expect(cls).toContain(`variation-color-${color}`);
    },
  );
});

describe('processMoveHierarchy (KS-2288 пробрасывает variationColor)', () => {
  function processedMoves(items: ReturnType<typeof processMoveHierarchy>): ProcessedMove[] {
    return items.filter(isProcessedMove);
  }
  function brackets(items: ReturnType<typeof processMoveHierarchy>): BracketItem[] {
    return items.filter(isBracketItem);
  }

  it('main-line ходы — variationColor=undefined независимо от move.variationColor', () => {
    // Хитрый case: даже если каким-то образом main-line move получил
    // variationColor (legacy PGN), на render должен быть undefined —
    // variation-color применим только к веткам.
    const moves = parseAnnotatedPgn('1. e4 e5 2. Nf3') as ChessMove[];
    moves[0].variationColor = 'green';
    const items = processMoveHierarchy(moves, null);
    for (const pm of processedMoves(items)) {
      expect(pm.variationColor).toBeUndefined();
    }
  });

  it('вариация с root.variationColor=green: все её ходы и скобки → green', () => {
    const moves = parseAnnotatedPgn(
      '1. e4 e5 (1... c5 {[%cvc G]} 2. Nf3 3. d4) 2. Nf3',
    ) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    // Найдём processed-ходы вариации (level=1) и проверим цвет.
    const variationMoves = processedMoves(items).filter((m) => m.level === 1);
    expect(variationMoves.length).toBeGreaterThanOrEqual(2);
    for (const pm of variationMoves) {
      expect(pm.variationColor).toBe('green');
    }
    // Скобки этой вариации тоже зелёные.
    const variationBrackets = brackets(items);
    expect(variationBrackets.length).toBe(2);
    for (const br of variationBrackets) {
      expect(br.variationColor).toBe('green');
    }
  });

  it('подвариация со СВОИМ цветом переопределяет наследуемый', () => {
    // 1.e4 e5 (1...c5 [%cvc G] 2.Nf3 (2.Nc3 [%cvc R] 2...d6) 2...Nc6)
    const moves = parseAnnotatedPgn(
      '1. e4 e5 (1... c5 {[%cvc G]} 2. Nf3 (2. Nc3 {[%cvc R]} 2... d6) 2... Nc6) 2. Nf3',
    ) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const all = processedMoves(items);
    // c5, Nf3, Nc6 — level=1 → green (root green).
    const greenLine = all.filter(
      (m) => m.level === 1 && (m.san === 'c5' || m.san === 'Nf3' || m.san === 'Nc6'),
    );
    expect(greenLine.length).toBeGreaterThanOrEqual(3);
    for (const m of greenLine) {
      expect(m.variationColor).toBe('green');
    }
    // Nc3 и d6 — level=2 (подвариация) → red (свой root).
    const redLine = all.filter(
      (m) => m.level === 2 && (m.san === 'Nc3' || m.san === 'd6'),
    );
    expect(redLine.length).toBeGreaterThanOrEqual(2);
    for (const m of redLine) {
      expect(m.variationColor).toBe('red');
    }
  });

  it('вариация без variationColor → undefined у всех её ходов (auto-coloring fallback)', () => {
    const moves = parseAnnotatedPgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3') as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const variationMoves = processedMoves(items).filter((m) => m.level === 1);
    for (const pm of variationMoves) {
      expect(pm.variationColor).toBeUndefined();
    }
    for (const br of brackets(items)) {
      expect(br.variationColor).toBeUndefined();
    }
  });

  it('подвариация без своего цвета → наследует от родительской ветки', () => {
    // 1.e4 e5 (1...c5 {[%cvc Y]} 2.Nf3 (2.Nc3 2...d6))
    // Подвариация (Nc3, d6) без [%cvc] → должна унаследовать yellow.
    const moves = parseAnnotatedPgn(
      '1. e4 e5 (1... c5 {[%cvc Y]} 2. Nf3 (2. Nc3 2... d6)) 2. Nf3',
    ) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const subVariation = processedMoves(items).filter(
      (m) => m.level === 2 && (m.san === 'Nc3' || m.san === 'd6'),
    );
    expect(subVariation.length).toBeGreaterThanOrEqual(2);
    for (const m of subVariation) {
      expect(m.variationColor).toBe('yellow');
    }
  });

  it('multi-variation: 2 вариации одного родителя — независимые цвета', () => {
    // 1.e4 e5 (1...c5 {[%cvc G]} 2.Nf3) (1...e6 {[%cvc B]} 2.d4)
    const moves = parseAnnotatedPgn(
      '1. e4 e5 (1... c5 {[%cvc G]} 2. Nf3) (1... e6 {[%cvc B]} 2. d4) 2. Nf3',
    ) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const all = processedMoves(items);
    const greenVar = all.filter(
      (m) => m.level === 1 && (m.san === 'c5' || m.san === 'Nf3'),
    );
    const blueVar = all.filter(
      (m) => m.level === 1 && (m.san === 'e6' || m.san === 'd4'),
    );
    for (const m of greenVar) expect(m.variationColor).toBe('green');
    for (const m of blueVar) expect(m.variationColor).toBe('blue');
  });
});

/**
 * KS-2828: рендер нотации главной линии должен учитывать стартовый
 * side-to-move и fullmove number из FEN-header PGN. Если первый ход
 * партии — чёрный (FEN: `... b ... 1 25`), его дисплей должен быть
 * `25...<SAN>`, а не `25.<SAN>` (как было до фикса). PgnDeserializer
 * правильно вычисляет `ply` через startPly, а formatMoveDisplay
 * раньше для случая «level=0, moveIndex=0, чёрный» возвращал просто
 * SAN без префикса — отсюда жалоба пользователя.
 */
describe('formatMoveDisplay main-line first move — black (KS-2828)', () => {
  function processedMoves(items: ReturnType<typeof processMoveHierarchy>) {
    return items.filter(isProcessedMove);
  }

  it('FEN с side-to-move=b, fullmove=1 → первый ход main-line: 1...<SAN>', () => {
    const pgn =
      '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 2. Nf3 Nc6';
    const moves = parseAnnotatedPgn(pgn) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const all = processedMoves(items);
    expect(all[0].display).toBe('1...e5');
    expect(all[1].display).toBe('2.Nf3');
    expect(all[2].display).toBe('Nc6');
  });

  it('FEN с side-to-move=b, fullmove=25 → первый ход main-line: 25...<SAN>', () => {
    // Произвольная mid-game позиция, ход чёрных, fullmove=25.
    const pgn =
      '[SetUp "1"]\n[FEN "r1bqkb1r/pp3ppp/2n2n2/2pp4/3P4/2N1PN2/PP3PPP/R1BQKB1R b KQkq - 0 25"]\n\n25... a6 26. Bd3';
    const moves = parseAnnotatedPgn(pgn) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const all = processedMoves(items);
    expect(all[0].display).toBe('25...a6');
    expect(all[1].display).toBe('26.Bd3');
  });

  it('FEN с side-to-move=w, fullmove=1 (стандартный старт): первый ход — 1.<SAN>', () => {
    // Регрессионный контроль — не сломать обычный сценарий «белые
    // начинают» добавленной веткой.
    const moves = parseAnnotatedPgn('1. e4 e5 2. Nf3') as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const all = processedMoves(items);
    expect(all[0].display).toBe('1.e4');
    expect(all[1].display).toBe('e5');
    expect(all[2].display).toBe('2.Nf3');
  });

  it('FEN с side-to-move=w, fullmove=8 → первый ход — 8.<SAN>', () => {
    const pgn =
      '[SetUp "1"]\n[FEN "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 8"]\n\n8. O-O O-O';
    const moves = parseAnnotatedPgn(pgn) as ChessMove[];
    const items = processMoveHierarchy(moves, null);
    const all = processedMoves(items);
    expect(all[0].display).toBe('8.O-O');
    expect(all[1].display).toBe('O-O');
  });
});
