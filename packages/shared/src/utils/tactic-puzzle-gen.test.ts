/**
 * KS-4338 / ADR-135 §2.3 — тесты shared `tactic-puzzle-gen`.
 *
 * Покрытие:
 *   * `replayPgnForTacticPuzzles` — валидный PGN, ошибка, фильтр startPly.
 *   * `analyzePlyForTacticPuzzle` — happy-path (всё проходит) и по одной
 *     ветке на каждую `TacticPuzzleRejectReason` через мок-движок и мок-Maia.
 *   * `processGameForTacticPuzzles` — high-level: PGN → candidates + stats.
 *
 * Фикстура happy-path воспроизводит позицию `48... Ne2+ $3` из партии
 * Pivovartsev–Hoffmann (см. историю прогона в /tmp/run-combined.mjs): на
 * двух проходах единственный сильный ход `Ne2+`, WDL почти полная ничья,
 * gap большой. Это эталонный «принятый» пазл по новому алгоритму.
 */
import { describe, expect, it } from 'vitest';
import {
  TACTIC_PUZZLE_GEN_DEFAULTS,
  analyzePlyForTacticPuzzle,
  newTacticDropStats,
  processGameForTacticPuzzles,
  replayPgnForTacticPuzzles,
  type MaiaPolicySource,
  type TacticPlyStep,
  type TacticPuzzleGenSettings,
  type TacticSfEngine,
  type TacticSfLine,
} from './tactic-puzzle-gen.js';
import type { Wdl } from './wdl.js';

const SETTINGS: TacticPuzzleGenSettings = { ...TACTIC_PUZZLE_GEN_DEFAULTS };

const STEP = (overrides: Partial<TacticPlyStep> = {}): TacticPlyStep => ({
  ply: 96,
  fen: '8/p7/5P2/6k1/8/4n1K1/1P5r/8 w - - 0 49', // условный FEN, не валидируем
  isGameOver: false,
  ...overrides,
});

function wdl(w: number, d: number, l: number): Wdl {
  return { w, d, l };
}

/**
 * Простой мок-движок: возвращает разные `lines` на main / verify проход.
 * Различаем по `nodes` (значение из settings) — пользователь обёртки
 * не контролирует порядок вызовов, кроме как через settings.
 */
function makeSf(args: {
  main: TacticSfLine[];
  verify: TacticSfLine[];
  mainDepth?: number;
  verifyDepth?: number;
  throwOn?: 'main' | 'verify' | null;
}): TacticSfEngine {
  return {
    analyze: async (_fen, _multiPV, nodes) => {
      const isMain = nodes === SETTINGS.sfMainNodes;
      if (args.throwOn === 'main' && isMain) throw new Error('sf main failed');
      if (args.throwOn === 'verify' && !isMain) {
        throw new Error('sf verify failed');
      }
      if (isMain) {
        return { lines: args.main, maxDepth: args.mainDepth ?? 18 };
      }
      return { lines: args.verify, maxDepth: args.verifyDepth ?? 20 };
    },
  };
}

function makeMaia(
  policy: Array<{ move: string; probability: number }>,
  opts?: { throws?: boolean },
): MaiaPolicySource {
  return {
    predictMoves: async () => {
      if (opts?.throws) throw new Error('maia onnx failed');
      return { policy };
    },
  };
}

// ─── replayPgnForTacticPuzzles ──────────────────────────────────────

describe('replayPgnForTacticPuzzles', () => {
  it('валидный PGN → массив steps, отфильтрованный по startPly', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 *';
    const r = replayPgnForTacticPuzzles(pgn, 6);
    if ('error' in r) throw new Error(r.error);
    expect(r.steps.length).toBe(10 - 6 + 1);
    expect(r.steps[0].ply).toBe(6);
    expect(r.steps[r.steps.length - 1].ply).toBe(10);
  });

  it('headers извлекаются', () => {
    const pgn = '[Event "Test"]\n[White "X"]\n\n1. e4 *';
    const r = replayPgnForTacticPuzzles(pgn, 1);
    if ('error' in r) throw new Error(r.error);
    expect(r.headers.Event).toBe('Test');
    expect(r.headers.White).toBe('X');
  });

  it('startPly выше длины партии → пустой массив', () => {
    const pgn = '1. e4 e5 *';
    const r = replayPgnForTacticPuzzles(pgn, 20);
    if ('error' in r) throw new Error(r.error);
    expect(r.steps).toEqual([]);
  });

  it('невалидный PGN → { error }', () => {
    const r = replayPgnForTacticPuzzles('not a pgn', 1);
    expect('error' in r).toBe(true);
  });
});

// ─── analyzePlyForTacticPuzzle ──────────────────────────────────────

describe('analyzePlyForTacticPuzzle', () => {
  it('happy: единственный сильный ход на обоих проходах, Maia трудно, gap большой → accepted', async () => {
    // Прототипный «48... Ne2+»: bestE≈0.499, secondE≈0, gap≈0.499,
    // WDL почти полная ничья.
    const sf = makeSf({
      main: [
        { move: 'e3c2', E: 0.5, wdl: wdl(1, 998, 1) },
        { move: 'h2g2', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verify: [
        { move: 'e3c2', E: 0.499, wdl: wdl(1, 997, 2) },
        { move: 'h2g2', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verifyDepth: 20,
    });
    // Maia даёт сильному ходу всего 2 % — difficulty = 0.98.
    const maia = makeMaia([
      { move: 'e3c2', probability: 0.02 },
      { move: 'h2g2', probability: 0.85 },
      { move: 'a7a6', probability: 0.13 },
    ]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') return;
    expect(r.candidate.bestMoveUci).toBe('e3c2');
    expect(r.candidate.gap).toBeCloseTo(0.499, 3);
    expect(r.candidate.difficulty).toBeCloseTo(0.98, 3);
    expect(r.candidate.depth).toBe(20);
  });

  // KS-4368 / KS-4367. Тест на objective='convertAdvantage' удалён —
  // поле objective убрано из TacticPuzzleCandidate целиком. Семантика
  // «реализуй перевес / удержи равенство» оказалась ad-hoc эвристикой
  // и не используется ни в UI, ни в логике отбора (см. пересмотр
  // ADR-135 §2.3, коммит f8fa746).

  it('gameOver → rejected', async () => {
    const sf = makeSf({ main: [], verify: [] });
    const maia = makeMaia([]);
    const r = await analyzePlyForTacticPuzzle(
      STEP({ isGameOver: true }),
      sf,
      maia,
      SETTINGS,
    );
    expect(r).toEqual({ kind: 'rejected', reason: 'gameOver' });
  });

  it('engineError на main → rejected', async () => {
    const sf = makeSf({ main: [], verify: [], throwOn: 'main' });
    const maia = makeMaia([]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'engineError' });
  });

  it('noEngineLines на main → rejected', async () => {
    const sf = makeSf({ main: [], verify: [{ move: 'a1a2', E: 1, wdl: wdl(1000, 0, 0) }] });
    const maia = makeMaia([]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'noEngineLines' });
  });

  it('notUniqueStrongMain → rejected (два хода в strongSet на main)', async () => {
    const sf = makeSf({
      main: [
        { move: 'a', E: 0.7, wdl: wdl(500, 500, 0) },
        { move: 'b', E: 0.69, wdl: wdl(490, 510, 0) }, // в пределах epsEquiv=0.02
      ],
      verify: [],
    });
    const maia = makeMaia([]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'notUniqueStrongMain' });
  });

  it('maiaLowDifficulty → rejected (Maia уверенно играет сильный ход)', async () => {
    const sf = makeSf({
      main: [
        { move: 'd1d8', E: 0.9, wdl: wdl(900, 100, 0) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verify: [],
    });
    // Maia даёт сильному ходу 95 % → difficulty=0.05 < 0.9.
    const maia = makeMaia([{ move: 'd1d8', probability: 0.95 }]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'maiaLowDifficulty' });
  });

  it('maiaInferenceFailed → rejected', async () => {
    const sf = makeSf({
      main: [
        { move: 'd1d8', E: 0.9, wdl: wdl(900, 100, 0) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verify: [],
    });
    const maia = makeMaia([], { throws: true });
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'maiaInferenceFailed' });
  });

  it('notUniqueStrongVerify → rejected', async () => {
    const sf = makeSf({
      main: [
        { move: 'd1d8', E: 0.9, wdl: wdl(900, 100, 0) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verify: [
        { move: 'd1d8', E: 0.7, wdl: wdl(500, 500, 0) },
        { move: 'd1d7', E: 0.69, wdl: wdl(490, 510, 0) }, // tie на verify
      ],
    });
    const maia = makeMaia([{ move: 'd1d8', probability: 0.05 }]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'notUniqueStrongVerify' });
  });

  it('bestMoveMismatch → rejected (main и verify дают разные лучшие)', async () => {
    const sf = makeSf({
      main: [
        { move: 'd1d8', E: 0.9, wdl: wdl(900, 100, 0) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verify: [
        { move: 'a1a2', E: 0.9, wdl: wdl(900, 100, 0) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
    });
    const maia = makeMaia([{ move: 'd1d8', probability: 0.05 }]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'bestMoveMismatch' });
  });

  it('bestMoveLoses → rejected (L лучшего > loseMax)', async () => {
    const maia = makeMaia([{ move: 'd1d8', probability: 0.05 }]);
    // L > loseMax=0.5: {100, 300, 600}.
    const sfWorse = makeSf({
      main: [
        { move: 'd1d8', E: 0.25, wdl: wdl(100, 300, 600) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
      verify: [
        { move: 'd1d8', E: 0.25, wdl: wdl(100, 300, 600) },
        { move: 'h2h3', E: 0.0, wdl: wdl(0, 0, 1000) },
      ],
    });
    const r = await analyzePlyForTacticPuzzle(STEP(), sfWorse, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'bestMoveLoses' });
  });

  it('gapTooSmall → rejected (bestE − secondE < gapMin)', async () => {
    const sf = makeSf({
      main: [
        { move: 'd1d8', E: 0.7, wdl: wdl(500, 500, 0) },
        { move: 'd1d7', E: 0.55, wdl: wdl(200, 700, 100) },
      ],
      verify: [
        { move: 'd1d8', E: 0.7, wdl: wdl(500, 500, 0) },
        { move: 'd1d7', E: 0.55, wdl: wdl(200, 700, 100) },
      ],
    });
    const maia = makeMaia([{ move: 'd1d8', probability: 0.05 }]);
    const r = await analyzePlyForTacticPuzzle(STEP(), sf, maia, SETTINGS);
    expect(r).toEqual({ kind: 'rejected', reason: 'gapTooSmall' });
  });
});

// ─── processGameForTacticPuzzles ────────────────────────────────────

describe('processGameForTacticPuzzles', () => {
  it('невалидный PGN → { error }', async () => {
    const r = await processGameForTacticPuzzles({
      pgn: 'broken',
      sf: makeSf({ main: [], verify: [] }),
      maia: makeMaia([]),
      settings: SETTINGS,
    });
    expect('error' in r).toBe(true);
  });

  it('партия без принятых позиций → стат отсева корректен', async () => {
    // Все позиции отбрасываются по notUniqueStrongMain (sf отдаёт ровно
    // два равных хода всегда).
    const sf: TacticSfEngine = {
      analyze: async () => ({
        lines: [
          { move: 'a', E: 0.5, wdl: wdl(100, 800, 100) },
          { move: 'b', E: 0.5, wdl: wdl(100, 800, 100) },
        ],
        maxDepth: 18,
      }),
    };
    const maia = makeMaia([]);
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *';
    const r = await processGameForTacticPuzzles({
      pgn,
      sf,
      maia,
      settings: { ...SETTINGS, startPly: 14 },
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.candidates).toEqual([]);
    expect(r.stats.drops.notUniqueStrongMain).toBeGreaterThan(0);
  });

  it('newTacticDropStats содержит все ключи enum', () => {
    const s = newTacticDropStats();
    const expectedKeys = [
      'gameOver',
      'engineError',
      'noEngineLines',
      'notUniqueStrongMain',
      'maiaInferenceFailed',
      'maiaLowDifficulty',
      'notUniqueStrongVerify',
      'bestMoveMismatch',
      'bestMoveLoses',
      'gapTooSmall',
    ];
    for (const k of expectedKeys) expect(s[k as keyof typeof s]).toBe(0);
    expect(Object.keys(s).sort()).toEqual([...expectedKeys].sort());
  });
});
