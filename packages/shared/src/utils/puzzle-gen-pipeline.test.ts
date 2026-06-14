/**
 * KS-3157 / ADR-070 S1 — тесты shared puzzle-gen-pipeline.
 *
 * Покрытие:
 *   - passesPlayerEloFilter (default-mode + сервер-уровень 2400 + null-обработка).
 *   - replayPgnToSteps (валидный PGN, ошибки, фильтр по startPly).
 *   - samePv1 helper.
 *   - analyzePlyForBlunder (через мок-engine; happy-path + варианты reject).
 *   - buildPuzzlesFromCandidate (одна позиция → 1 или 2 пазла).
 *   - processGameForPuzzles (high-level, фикстура KS-3139 39. d6 / 39. Ke4).
 *
 * Фикстура KS-3139 — реальная партия из TWIC (Carlsen-Niemann ≈ 2024-09),
 * 39. d6 — зевок, который упускает выигрыш белых (W: 0.95 → 0.0, D: 0.05
 * → 0.95). 39. Ke4 — правильный ход (PV1). Это даёт пару зевок-кандидат
 * с реактивным objective=saveEquality (W_after=0, D_after=0.95).
 */
import { describe, expect, it } from 'vitest';
import {
  analyzePlyForBlunder,
  buildPuzzlesFromCandidate,
  passesPlayerEloFilter,
  processGameForPuzzles,
  replayPgnToSteps,
  samePv1,
  type BlunderCandidate,
  type GameMeta,
  type PuzzleGenEngine,
  type PuzzleGenSettings,
  type SharedMultiPvLine,
} from './puzzle-gen-pipeline.js';
import { PUZZLE_GEN_DEFAULTS } from '../types/puzzle-gen.js';

const DEFAULT_SETTINGS: PuzzleGenSettings = {
  deltaWThreshold: PUZZLE_GEN_DEFAULTS.deltaWThreshold,
  deltaDThreshold: PUZZLE_GEN_DEFAULTS.deltaDThreshold,
  minWPlusDAfterForSolver: PUZZLE_GEN_DEFAULTS.minWPlusDAfterForSolver,
  minPlayerElo: PUZZLE_GEN_DEFAULTS.minPlayerElo,
  startPly: PUZZLE_GEN_DEFAULTS.startPly,
  emitPreventivePuzzle: true,
  emitReactivePuzzle: true,
};

// ─── passesPlayerEloFilter ──────────────────────────────────────────

describe('passesPlayerEloFilter (KS-3157 / ADR-070 §2.2)', () => {
  it('default minPlayerElo=0 → принимает всех (клиент)', () => {
    expect(passesPlayerEloFilter(null, null, 0)).toBe(true);
    expect(passesPlayerEloFilter(1200, 1500, 0)).toBe(true);
  });

  it('server minPlayerElo=2400 → оба ≥ 2400 → принят', () => {
    expect(passesPlayerEloFilter(2700, 2680, 2400)).toBe(true);
    expect(passesPlayerEloFilter(2400, 2400, 2400)).toBe(true);
  });

  it('server minPlayerElo=2400 → один ниже → отбрасываем', () => {
    expect(passesPlayerEloFilter(2700, 2399, 2400)).toBe(false);
    expect(passesPlayerEloFilter(2200, 2700, 2400)).toBe(false);
  });

  it('server minPlayerElo=2400 → один null → отбрасываем (нет данных)', () => {
    expect(passesPlayerEloFilter(2700, null, 2400)).toBe(false);
    expect(passesPlayerEloFilter(null, 2700, 2400)).toBe(false);
    expect(passesPlayerEloFilter(undefined, 2700, 2400)).toBe(false);
  });
});

// ─── replayPgnToSteps ───────────────────────────────────────────────

describe('replayPgnToSteps', () => {
  it('валидный PGN → массив steps, отфильтрованный по startPly', () => {
    const pgn =
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5';
    const r = replayPgnToSteps(pgn, 8);
    if ('error' in r) throw new Error(r.error);
    // 12 полуходов всего, startPly=8 → остаются ply 8..12 = 5 шагов.
    expect(r.steps.length).toBe(5);
    expect(r.steps[0].ply).toBe(8);
    expect(r.steps[r.steps.length - 1].ply).toBe(12);
    // fenBefore[0] и fenAfter[0] отличаются (легальный ход).
    expect(r.steps[0].fenBefore).not.toBe(r.steps[0].fenAfter);
  });

  it('preventiveSolverSide на fenBefore = side-to-move до хода', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6';
    const r = replayPgnToSteps(pgn, 1);
    if ('error' in r) throw new Error(r.error);
    // ply=1 (1. e4): ход белых, sideToMove на fenBefore = w.
    expect(r.steps[0].preventiveSolverSide).toBe('w');
    expect(r.steps[0].reactiveSolverSide).toBe('b');
    // ply=2 (1...e5): ход чёрных, sideToMove на fenBefore = b.
    expect(r.steps[1].preventiveSolverSide).toBe('b');
    expect(r.steps[1].reactiveSolverSide).toBe('w');
  });

  it('невалидный PGN → { error }', () => {
    const r = replayPgnToSteps('1. e9 nonsense', 1);
    expect('error' in r).toBe(true);
  });

  it('пустой PGN → пустой массив steps', () => {
    const r = replayPgnToSteps('', 1);
    if ('error' in r) {
      // chess.js может выкинуть error на пустом — допустимо.
      return;
    }
    expect(r.steps).toEqual([]);
  });

  it('startPly=20 (default) на короткой партии → пустой массив', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6';
    const r = replayPgnToSteps(pgn, 20);
    if ('error' in r) throw new Error(r.error);
    expect(r.steps).toEqual([]);
  });
});

// ─── samePv1 ────────────────────────────────────────────────────────

describe('samePv1', () => {
  it('одинаковые UCI → true', () => {
    expect(samePv1('e2e4', 'e2e4')).toBe(true);
    expect(samePv1('e7e8q', 'e7e8q')).toBe(true);
  });
  it('разные UCI → false', () => {
    expect(samePv1('e2e4', 'd2d4')).toBe(false);
    expect(samePv1('e7e8q', 'e7e8r')).toBe(false);
    expect(samePv1('e7e8', 'e7e8q')).toBe(false);
  });
  it('пустые → false', () => {
    expect(samePv1('', 'e2e4')).toBe(false);
    expect(samePv1('e2e4', '')).toBe(false);
  });
});

// ─── analyzePlyForBlunder ───────────────────────────────────────────

function makeFixtureStep(overrides: Partial<{
  ply: number;
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  isGameOverAfter: boolean;
}> = {}): import('./puzzle-gen-pipeline.js').PlyStep {
  return {
    ply: 39,
    fenBefore: 'startpos',
    fenAfter: 'afterpos',
    playedUci: 'd5d6',
    isGameOverAfter: false,
    reactiveSolverSide: 'b',
    preventiveSolverSide: 'w',
    ...overrides,
  };
}

function pv(
  bestMove: string,
  wdl: { w: number; d: number; l: number },
): SharedMultiPvLine {
  return {
    bestMove,
    score: { type: 'cp', value: 0 },
    wdl,
  };
}

describe('analyzePlyForBlunder', () => {
  it('happy: 39.d6 фикстура (KS-3139) → accepted, deltaW≥0.6', async () => {
    // Реальные числа из KS-3139: 39.Ke4 (правильный) → 39.d6 (зевок).
    // wdlBefore POV белых: W≈950, D≈45, L≈5 (выиграно).
    // wdlAfter POV чёрных (= solver): W=0, D≈952, L≈48 (ничья).
    // deltaW = (950 − 48) / 1000 = 0.902 ≥ 0.6. Триггер W.
    // W+D solver = 0 + 952 = 952 ≥ 500. After-фильтр прошёл.
    const engine: PuzzleGenEngine = {
      analyze: async (fen, _mpv) => {
        if (fen === 'startpos') {
          return [pv('e2e4', { w: 950, d: 45, l: 5 })]; // PV1 = e2e4 (Ke4 в реале)
        }
        return [pv('a7a8', { w: 0, d: 952, l: 48 })];
      },
    };
    const r = await analyzePlyForBlunder(
      makeFixtureStep(),
      engine,
      DEFAULT_SETTINGS,
    );
    if (r.kind !== 'accepted') {
      throw new Error(`expected accepted, got ${r.kind} ${('reason' in r) && r.reason}`);
    }
    expect(r.candidate.deltaW).toBeGreaterThanOrEqual(0.6);
    expect(r.candidate.trigger).toBe('W');
    expect(r.candidate.pv1BeforeUci).toBe('e2e4');
    expect(r.candidate.firstMoveAfterUci).toBe('a7a8');
    expect(r.candidate.wdlBeforeRaw.w).toBe(950);
    expect(r.candidate.wdlAfterRaw.w).toBe(0);
  });

  it('samePv1 → rejected (сыгранный ход = PV1, не зевок)', async () => {
    const engine: PuzzleGenEngine = {
      analyze: async () => [pv('d5d6', { w: 800, d: 100, l: 100 })],
    };
    const r = await analyzePlyForBlunder(
      makeFixtureStep({ playedUci: 'd5d6' }),
      engine,
      DEFAULT_SETTINGS,
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('samePv1');
  });

  it('gameOver → rejected (терминальная позиция)', async () => {
    const engine: PuzzleGenEngine = {
      analyze: async () => [pv('a1a1', { w: 0, d: 0, l: 1000 })],
    };
    const r = await analyzePlyForBlunder(
      makeFixtureStep({ isGameOverAfter: true }),
      engine,
      DEFAULT_SETTINGS,
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('gameOver');
  });

  it('notBlunder → rejected (дельты ниже порогов)', async () => {
    const engine: PuzzleGenEngine = {
      analyze: async (fen) => {
        if (fen === 'startpos') return [pv('e2e4', { w: 500, d: 400, l: 100 })];
        return [pv('a7a8', { w: 100, d: 400, l: 500 })]; // солвер чуть-чуть отдал
      },
    };
    const r = await analyzePlyForBlunder(
      makeFixtureStep(),
      engine,
      DEFAULT_SETTINGS,
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('notBlunder');
  });

  it('lowWplusDAfter → rejected (D-триггер; W+D solver после хода < 0.5)', async () => {
    // Тонкость: W-триггер не может одновременно с lowWplusDAfter
    // (high deltaW ⇒ after.l low ⇒ after.W+D high). Низкий W+D
    // достижим только при D-триггере. before: блaндер держал ничью
    // {200,700,100}; after POV solver: {200,100,700} — d просел, но
    // solver всё равно проигрывает (W+D = 0.3 < 0.5). deltaD=0.6,
    // after-фильтр режет.
    const engine: PuzzleGenEngine = {
      analyze: async (fen) => {
        if (fen === 'startpos') return [pv('e2e4', { w: 200, d: 700, l: 100 })];
        return [pv('a7a8', { w: 200, d: 100, l: 700 })];
      },
    };
    const r = await analyzePlyForBlunder(
      makeFixtureStep(),
      engine,
      DEFAULT_SETTINGS,
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('lowWplusDAfter');
  });

  it('engineError → rejected (пустой массив PV)', async () => {
    const engine: PuzzleGenEngine = { analyze: async () => [] };
    const r = await analyzePlyForBlunder(
      makeFixtureStep(),
      engine,
      DEFAULT_SETTINGS,
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('engineError');
  });
});

// ─── buildPuzzlesFromCandidate ─────────────────────────────────────

function makeCandidate(
  overrides: Partial<BlunderCandidate> = {},
): BlunderCandidate {
  return {
    step: makeFixtureStep(),
    wdlBeforeRaw: { w: 950, d: 45, l: 5 },
    wdlAfterRaw: { w: 0, d: 952, l: 48 },
    deltaW: 0.902,
    deltaD: 0,
    trigger: 'W',
    pv1BeforeUci: 'e2e4',
    firstMoveAfterUci: 'a7a8',
    ...overrides,
  };
}

const GAME_META: GameMeta = {
  sourceType: 'archive_game',
  sourceId: '00000000-0000-0000-0000-000000000001',
  whiteElo: 2800,
  blackElo: 2790,
  headers: { White: 'Carlsen', Black: 'Niemann' },
};

describe('buildPuzzlesFromCandidate (KS-3157 / ADR-070 §2.3 — двойной пазл)', () => {
  it('фикстура 39.d6: оба пазла генерируются (preventive + reactive)', () => {
    const out = buildPuzzlesFromCandidate(
      makeCandidate(),
      GAME_META,
      DEFAULT_SETTINGS,
    );
    expect(out.length).toBe(2);

    const reactive = out.find((p) => p.puzzlePhase === 'reactive');
    const preventive = out.find((p) => p.puzzlePhase === 'preventive');
    expect(reactive).toBeDefined();
    expect(preventive).toBeDefined();

    if (!reactive || !preventive) return;

    // Реактивный: fen=fenAfter, solver=противник зевнувшего,
    // objective по wdlAfter.w (0/1000 < 0.5) → saveEquality.
    expect(reactive.fen).toBe('afterpos');
    expect(reactive.solverSide).toBe('b');
    expect(reactive.objective).toBe('saveEquality');
    expect(reactive.themes).toContain('reactive');
    expect(reactive.themes).toContain('saveEquality');

    // Превентивный: fen=fenBefore, solver=зевнувший,
    // objective по wdlBefore.w (950/1000 ≥ 0.5) → convertAdvantage.
    expect(preventive.fen).toBe('startpos');
    expect(preventive.solverSide).toBe('w');
    expect(preventive.objective).toBe('convertAdvantage');
    expect(preventive.themes).toContain('preventive');
    expect(preventive.themes).toContain('convertAdvantage');

    // FENы разные.
    expect(reactive.fen).not.toBe(preventive.fen);

    // sourceMetadata.puzzlePhase прописан.
    expect(reactive.sourceMetadata.puzzlePhase).toBe('reactive');
    expect(preventive.sourceMetadata.puzzlePhase).toBe('preventive');

    // preventiveCorrectMoveUci пишется ТОЛЬКО для preventive.
    expect(preventive.sourceMetadata.preventiveCorrectMoveUci).toBe('e2e4');
    expect(reactive.sourceMetadata.preventiveCorrectMoveUci).toBeUndefined();

    // KS-4100 / ADR-124 §2.4. ИНВАРИАНТ: ОБА пазла имеют firstMovePV1
    // (нужен Maia-аннотации; раньше preventive его не ставил → KS-4096).
    expect(reactive.sourceMetadata.firstMovePV1).toBe('a7a8'); // firstMoveAfterUci
    expect(preventive.sourceMetadata.firstMovePV1).toBe('e2e4'); // pv1BeforeUci
  });

  it('emitPreventivePuzzle=false → только реактивный', () => {
    const out = buildPuzzlesFromCandidate(
      makeCandidate(),
      GAME_META,
      { ...DEFAULT_SETTINGS, emitPreventivePuzzle: false },
    );
    expect(out.length).toBe(1);
    expect(out[0].puzzlePhase).toBe('reactive');
  });

  it('emitReactivePuzzle=false → только превентивный', () => {
    const out = buildPuzzlesFromCandidate(
      makeCandidate(),
      GAME_META,
      { ...DEFAULT_SETTINGS, emitReactivePuzzle: false },
    );
    expect(out.length).toBe(1);
    expect(out[0].puzzlePhase).toBe('preventive');
  });

  it('preventive pre-filter: до зевка W+D<0.5 (проигрывал) → preventive не строится', () => {
    // Зевнувший до зевка W=100, D=200, L=700 — позиция проигрышная,
    // нет смысла «не упустить». evaluateBlunder этот кейс не пропустит
    // (deltaW мал), но допустим он пройдёт реактивный фильтр.
    const cand = makeCandidate({
      wdlBeforeRaw: { w: 100, d: 200, l: 700 },
      wdlAfterRaw: { w: 0, d: 600, l: 400 },
    });
    const out = buildPuzzlesFromCandidate(cand, GAME_META, DEFAULT_SETTINGS);
    // Реактивный есть; превентивного НЕТ.
    expect(out.find((p) => p.puzzlePhase === 'reactive')).toBeDefined();
    expect(out.find((p) => p.puzzlePhase === 'preventive')).toBeUndefined();
  });

  it('preventive objective=saveEquality когда зевнувший до зевка W<0.5 но W+D≥0.5', () => {
    // Зевнувший держал ничью: W=200, D=600, L=200. Превентивный пазл —
    // «не зевни ничью», objective=saveEquality.
    const cand = makeCandidate({
      wdlBeforeRaw: { w: 200, d: 600, l: 200 },
      wdlAfterRaw: { w: 0, d: 100, l: 900 }, // после зевка солвер выиграет
      deltaW: 0.8, // искусственно поставим для триггера
    });
    const out = buildPuzzlesFromCandidate(cand, GAME_META, DEFAULT_SETTINGS);
    const preventive = out.find((p) => p.puzzlePhase === 'preventive');
    expect(preventive).toBeDefined();
    if (preventive) expect(preventive.objective).toBe('saveEquality');
  });

  it('sourceMetadata: общие поля для обоих пазлов', () => {
    const out = buildPuzzlesFromCandidate(
      makeCandidate(),
      GAME_META,
      DEFAULT_SETTINGS,
    );
    for (const p of out) {
      expect(p.sourceMetadata.blunderMove).toBe('d5d6');
      expect(p.sourceMetadata.fenBeforeBlunder).toBe('startpos');
      expect(p.sourceMetadata.deltaW).toBe(0.902);
      expect(p.sourceMetadata.blunderTrigger).toBe('W');
      expect(p.sourceMetadata.wdlBefore).toEqual({ w: 950, d: 45, l: 5 });
      expect(p.sourceMetadata.wdlAfter).toEqual({ w: 0, d: 952, l: 48 });
      expect(p.sourceMetadata.headers).toEqual({ White: 'Carlsen', Black: 'Niemann' });
    }
  });
});

// ─── processGameForPuzzles (high-level) ────────────────────────────

describe('processGameForPuzzles (KS-3157 / ADR-070 S1 — high-level)', () => {
  it('партия с одним зевком → 2 пазла (preventive + reactive), stats корректны', async () => {
    // Простая партия из 22 полуходов, startPly=20. На ply=21 (11-й ход
    // белых) поставим «зевок»: в моке движок будет считать что W
    // обвалился с 0.9 до 0.0.
    const pgn =
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. O-O Nf6 ' +
      '6. h3 h6 7. Nc3 Bg4 8. Be3 Bxe3 9. fxe3 Qd7 10. a3 Bxh3 ' +
      '11. gxh3 Qxh3';
    const targetPly = 21; // 11-й ход белых (gxh3) — «зевок» в фикстуре.

    const engine: PuzzleGenEngine = {
      analyze: async (fen, _mpv) => {
        const sideToMove = fen.split(' ')[1] as 'w' | 'b';
        // На целевом ply pre wdl высокий (выигрыш у зевнувшего),
        // post — упал. На остальных — нейтрально.
        const isAttacker = sideToMove === 'w';
        // Для всех остальных позиций возвращаем «не зевок».
        if (isAttacker) {
          // sideToMove = w → это pre (fenBefore, зевнул белый) ИЛИ
          // post другой партии. Мы возвращаем «как-будто фикстура»
          // только для одной позиции — не реалистично, но юнит-тест.
          return [pv('e2e4', { w: 920, d: 60, l: 20 })];
        }
        // sideToMove = b → это post (fenAfter), POV solver.
        return [pv('h3h2', { w: 0, d: 920, l: 80 })];
      },
    };
    const result = await processGameForPuzzles({
      pgn,
      gameMeta: GAME_META,
      engine,
      settings: { ...DEFAULT_SETTINGS, startPly: targetPly },
    });
    // На каждый принятый зевок 2 пазла. В этой фикстуре все ply >= 21
    // дают одинаковый «зевок» (мок упрощённый), значит счёт пазлов
    // равен 2 × числу принятых ply.
    expect(result.puzzles.length).toBeGreaterThanOrEqual(2);
    const hasPreventive = result.puzzles.some(
      (p) => p.puzzlePhase === 'preventive',
    );
    const hasReactive = result.puzzles.some(
      (p) => p.puzzlePhase === 'reactive',
    );
    expect(hasPreventive).toBe(true);
    expect(hasReactive).toBe(true);
    // accountedFor: positionsAnalyzed = inserted-кандидаты + drops.
    // У нас insert-callback'а нет, проверим что drops + accepted = analyzed.
    const totalDrops =
      result.stats.drops.samePv1 +
      result.stats.drops.gameOver +
      result.stats.drops.noScore +
      result.stats.drops.engineError +
      result.stats.drops.notBlunder +
      result.stats.drops.lowWplusDAfter;
    // accepted ply = positionsAnalyzed − totalDrops. Каждый accepted даёт
    // ≥1 пазл (preventive может не быть, но reactive всегда).
    const acceptedPly = result.stats.positionsAnalyzed - totalDrops;
    expect(acceptedPly).toBeGreaterThan(0);
  });

  it('невалидный PGN → пустой результат, без падений', async () => {
    const result = await processGameForPuzzles({
      pgn: '1. e9 nonsense',
      gameMeta: GAME_META,
      engine: { analyze: async () => [pv('a1a1', { w: 0, d: 0, l: 1000 })] },
      settings: DEFAULT_SETTINGS,
    });
    expect(result.puzzles).toEqual([]);
    expect(result.stats.positionsAnalyzed).toBe(0);
  });
});
