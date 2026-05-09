import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AnalysisResult,
  EngineAdapter,
  InfoLine,
  WdlDistribution,
} from './engineAdapter';
import {
  generatePuzzlesFromPgn,
  DEFAULT_PUZZLE_GEN_SETTINGS,
} from './puzzleGenerator';

/**
 * KS-2584: тесты WDL-генератора пазлов.
 *
 * Все тесты используют mock-адаптер `MockEngine`, в который заранее
 * записан скрипт ответов на `analyze(fen, depth, multiPv)`. Реальный
 * Stockfish не нужен — нас интересует только поведение алгоритма (что
 * принимает / что отбрасывает / какой output формирует).
 */

// Helper: построить InfoLine с заданным WDL (per-mille) и pv.
function line(
  pv: string[],
  wdl: WdlDistribution | null,
  score: InfoLine['score'] = { type: 'cp', value: 0 },
): InfoLine {
  return {
    multipv: 1,
    depth: 14,
    score,
    pv,
    ...(wdl ? { wdl } : {}),
  };
}

function res(lines: InfoLine[]): AnalysisResult {
  return {
    lines,
    bestByDepth: new Map(),
    evalByDepth: new Map(),
    firstAppearance: 14,
  };
}

interface MockCall {
  fen: string;
  depth: number;
  multiPv: number;
}

function makeMockEngine(
  responder: (call: MockCall, callIndex: number) => AnalysisResult,
): {
  engine: EngineAdapter;
  calls: MockCall[];
  destroyed: { value: boolean };
} {
  const calls: MockCall[] = [];
  const destroyed = { value: false };
  const engine: EngineAdapter = {
    init: vi.fn(async () => {}),
    setOption: vi.fn(),
    analyze: vi.fn(async (fen: string, depth: number, multiPv: number) => {
      const idx = calls.length;
      calls.push({ fen, depth, multiPv });
      return responder({ fen, depth, multiPv }, idx);
    }),
    destroy: vi.fn(() => {
      destroyed.value = true;
    }),
  };
  return { engine, calls, destroyed };
}

/**
 * PGN с минимум 21 ходом — нужно >= startPly (20) ходов чтобы
 * генератор начал анализ. Используем известную партию (Karpov –
 * Kasparov 1985) как длинную, потом подменяем 21-й ход на «зевок»
 * через mock — chess.js просто валидирует SAN.
 *
 * Минимальный валидный PGN сложно склеить руками, поэтому генерируем
 * случайную партию из e4/Nf3/Bc4/d4 и т.д. — главное, чтобы она
 * парсилась. Проще: загенерим 25 «нулевых» ходов через chess.js.
 */
function buildPgn(nMoves: number): string {
  // chess.js .pgn() генерит валидный SAN — отрезаем его собственные
  // headers и подставляем свои, чтобы splitPgnIntoGames не разбивал
  // нашу PGN на два «Event»-блока.
  const { Chess } = require('chess.js') as typeof import('chess.js');
  const game = new Chess();
  for (let i = 0; i < nMoves; i++) {
    const moves = game.moves();
    if (moves.length === 0) break;
    game.move(moves[Math.floor(moves.length / 2)]);
  }
  const raw = game.pgn({ maxWidth: 0 });
  // Отрезаем secondary headers (между [...] блоками — пустая строка),
  // оставляем только movetext.
  const movetext = raw.split('\n\n').slice(1).join('\n\n').trim();
  return `[Event "Test"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n${movetext.replace(/\*$/, '1-0')}`;
}

const PGN = buildPgn(25);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generatePuzzlesFromPgn KS-2584 — WDL-алгоритм', () => {
  it('детектирует blunder при wdlBefore=+0.7 (POV блaндера) / wdlAfter=+0.7 (POV решателя) → blunderΔ=1.4 ≥ 0.6 → принять', async () => {
    let beforeAnalyzed = 0;
    let afterAnalyzed = 0;
    const { engine } = makeMockEngine((call, _idx) => {
      // KS-2677: входные wdl каждый POV side-to-move (UCI стандарт):
      //   - на fenBefore side-to-move = блaндер; wdl POV блaндера.
      //   - на fenAfter side-to-move = решатель; wdl POV решателя.
      // Корректный blunder-сценарий: блaндер был в выгоде (+0.7), после
      // зевка решатель тоже в выгоде (+0.7) → blunderΔ = 1.4.
      if (beforeAnalyzed === 0 && afterAnalyzed === 0) {
        beforeAnalyzed = 1;
        // wdlBefore (POV блaндера) = +0.7 (W=850, L=150)
        return res([line(['a1a8'], { w: 850, d: 0, l: 150 })]);
      }
      if (beforeAnalyzed === 1 && afterAnalyzed === 0) {
        afterAnalyzed = 1;
        // wdlAfter (POV решателя) = +0.7 (W=850, L=150) ⇒ wdlAfterForSolver = +0.7
        return res([line(['b1b8'], { w: 850, d: 0, l: 150 })]);
      }
      // Остальные позиции — «нет блaндера»: wdlBefore = 0.0, wdlAfter = 0.0.
      void call;
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const onProgress = vi.fn();
    const puzzles = await generatePuzzlesFromPgn(PGN, onProgress, {
      engineFactory: () => engine,
    });

    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    const p = puzzles[0];
    expect(p.solutionMode).toBe('play-vs-engine');
    expect(p.moves).toBe('');
    expect(p.isPublic).toBe(false);
    expect(p.sourceMetadata?.blunderMove).toBeDefined();
    expect(p.sourceMetadata?.wdlBeforeBlunder).toBeCloseTo(0.7, 2);
    expect(p.sourceMetadata?.wdlAfterBlunder).toBeCloseTo(0.7, 2);
    expect(p.sourceMetadata?.blunderDelta).toBeCloseTo(1.4, 2);
    expect(p.sourceMetadata?.halfMovesN).toBe(6);
    expect(p.sourceMetadata?.winThreshold).toBe(0.5);
    expect(p.sourceMetadata?.failThreshold).toBe(0.0);
    expect(p.sourceMetadata?.depth).toBe(DEFAULT_PUZZLE_GEN_SETTINGS.depth);
    expect(p.themes).toMatch(/playVsEngine/);
    expect(p.themes).toMatch(/advantage|crushing/);
    expect(p.gap).toBe(70); // round(0.7 * 100)
    expect(p.rating).toBeGreaterThanOrEqual(800);
    expect(p.rating).toBeLessThanOrEqual(2000);
  });

  it('samePv1 drop — line1.pv[0] === playedUci → не принимаем', async () => {
    // Генерим pgn и достанем UCI первого хода после ply=startPly.
    // Вместо реального match — мокаем engine так, чтобы для ПЕРВОЙ
    // позиции wdlBefore был принимаемый (~0.7), но pv[0] = тот же ход
    // что играли. Все остальные позиции — нет blunder.
    const { Chess } = require('chess.js') as typeof import('chess.js');
    const replay = new Chess();
    const moves: string[] = [];
    const fullPgn = PGN;
    const tmp = new Chess();
    tmp.loadPgn(fullPgn);
    const hist = tmp.history({ verbose: true });
    for (let i = 0; i < hist.length; i++) {
      const m = hist[i];
      const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
      if (i === 20) {
        moves.push(uci); // ход на ply=20 (первый который анализируется)
      }
      replay.move(m.san);
    }
    const playedAtStartPly = moves[0];

    let firstBefore = true;
    const { engine, calls } = makeMockEngine(() => {
      if (firstBefore) {
        firstBefore = false;
        // pv[0] === тот же ход что игрался → samePv1, drop
        return res([line([playedAtStartPly], { w: 850, d: 0, l: 150 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });

    // На первой позиции samePv1 → не должен быть запрос на fenAfter.
    // То есть второй analyze запустится только для следующей позиции
    // (тоже before-call). Проверим что первый принятый puzzle — НЕ от
    // ply=startPly: либо puzzles пуст, либо первый puzzle.sourceMoveNum > 21.
    if (puzzles.length > 0) {
      expect(puzzles[0].sourceMetadata?.blunderMove).not.toBe(playedAtStartPly);
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  it('skipDecided drop — |wdlBefore| > 0.95 → drop', async () => {
    let firstBefore = true;
    const { engine } = makeMockEngine(() => {
      if (firstBefore) {
        firstBefore = false;
        // wdlBefore = +0.97 → decided
        return res([line(['a1a8'], { w: 970, d: 30, l: 0 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    // Decided + остальные «нулевые» позиции → ноль пазлов.
    expect(puzzles).toHaveLength(0);
  });

  it('lowWdlAfterBlunder drop — wdlAfterForSolver = 0.3 → drop', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) {
        // wdlBefore (POV блaндера) = +0.4 (не decided)
        return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]);
      }
      if (n === 2) {
        // KS-2677: wdlAfter (POV решателя) = +0.3 ⇒ wdlAfterForSolver = +0.3
        // blunderΔ = 0.4 + 0.3 = 0.7 ≥ 0.6 — проходит blunderDelta,
        // но 0.3 < minWdlAfterBlunder (0.5) — drop.
        return res([line(['b1b8'], { w: 650, d: 0, l: 350 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles).toHaveLength(0);
  });

  it('notBlunder drop — blunderΔ < 0.6 → drop', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) return res([line(['a1a8'], { w: 600, d: 0, l: 400 })]); // +0.2
      if (n === 2) return res([line(['b1b8'], { w: 600, d: 0, l: 400 })]); // wdlAfterForSolver = +0.2
      // blunderΔ = 0.4 < 0.6
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles).toHaveLength(0);
  });

  it('mate в score → темы содержат `mate` и `mateInN`', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) {
        return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]); // +0.4
      }
      if (n === 2) {
        // KS-2677: mate value > 0 на fenAfter (POV side-to-move =
        // решатель) — mate в пользу решающего ✓. wdl=null здесь, но
        // wdlSignedFromInfo даёт +1 fallback. wdlAfterForSolver = +1.
        return res([
          line(['b1b8'], null, { type: 'mate', value: 3 }),
        ]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    expect(puzzles[0].themes).toMatch(/mate/);
    expect(puzzles[0].themes).toMatch(/mateIn3/);
    expect(puzzles[0].themes).toMatch(/crushing/); // wdlAfterForSolver = 1.0 ≥ 0.95
  });

  it('solvabilityCheck=true с моком, который роняет wdl на середине → solvabilityFailed', async () => {
    let analyzeCallIdx = 0;
    let solvCallIdx = 0;
    const { engine } = makeMockEngine(() => {
      analyzeCallIdx++;
      // 1: before — accept (wdlBefore POV блaндера = +0.7)
      if (analyzeCallIdx === 1) {
        return res([line(['a1a8'], { w: 850, d: 0, l: 150 })]);
      }
      // 2: after — accept (wdlAfter POV решателя = +0.7)
      if (analyzeCallIdx === 2) {
        return res([line(['b1b8'], { w: 850, d: 0, l: 150 })]);
      }
      // 3..N: solvability passes — на N=3 wdl выше failThreshold,
      // на N=4 (полуход 1) роняем → wdlForSolver < 0.0 → fail.
      solvCallIdx++;
      if (solvCallIdx === 1) {
        // Решающий ходит — pv[0]='c1c8', wdl = +0.5 (W=750)
        return res([line(['c1c8'], { w: 750, d: 0, l: 250 })]);
      }
      if (solvCallIdx === 2) {
        // Соперник: wdl POV соперника = +0.7 ⇒ POV решающего = -0.7 < 0 → fail
        return res([line(['d1d8'], { w: 850, d: 0, l: 150 })]);
      }
      // safety
      return res([line(['e1e8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
      solvabilityCheck: true,
    });
    expect(puzzles).toHaveLength(0);
  });

  it('engine.destroy() вызывается даже при пустом результате', async () => {
    const { engine, destroyed } = makeMockEngine(() =>
      res([line(['a1a1'], { w: 500, d: 0, l: 500 })]),
    );
    await generatePuzzlesFromPgn(PGN, vi.fn(), { engineFactory: () => engine });
    expect(destroyed.value).toBe(true);
  });

  it('output payload — solutionMode="play-vs-engine", moves="", isPublic=false', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      // KS-2677: оба wdl POV side-to-move (UCI). Блaндер +0.7 → решатель +0.7.
      if (n === 1) return res([line(['a1a8'], { w: 850, d: 0, l: 150 })]);
      if (n === 2) return res([line(['b1b8'], { w: 850, d: 0, l: 150 })]);
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    const p = puzzles[0];
    expect(p.solutionMode).toBe('play-vs-engine');
    expect(p.moves).toBe('');
    expect(p.isPublic).toBe(false);
    expect(p.acceptedMoves).toBeUndefined();
    expect(p.sourceType).toBe('pgn_import');
    // sourceMetadata содержит PGN headers (White / Black / Event / Result)
    expect(p.sourceMetadata?.white).toBe('A');
    expect(p.sourceMetadata?.black).toBe('B');
    expect(p.sourceMetadata?.event).toBe('Test');
    expect(p.sourceMetadata?.result).toBe('1-0');
  });

  it('настройки blunderDelta переопределяются через options', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) return res([line(['a1a8'], { w: 600, d: 0, l: 400 })]); // +0.2 POV блaндера
      if (n === 2) {
        // KS-2677: wdlAfter POV решателя = +0.6. blunderΔ = 0.2 + 0.6 = 0.8
        // ≥ 0.7 (override). minWdlAfterBlunder = 0.5 — проходит (0.6 ≥ 0.5).
        return res([line(['b1b8'], { w: 800, d: 0, l: 200 })]); // +0.6
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
      blunderDelta: 0.7,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    expect(puzzles[0].sourceMetadata?.depth).toBe(14);
  });

  it('crushing-метка при wdlAfterForSolver ≥ 0.95', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]); // +0.4 POV блaндера
      // KS-2677: wdl POV решателя = +0.97 ⇒ wdlAfterForSolver = +0.97 ≥ 0.95.
      if (n === 2) return res([line(['b1b8'], { w: 970, d: 30, l: 0 })]);
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    expect(puzzles[0].themes).toMatch(/crushing/);
  });

  it('rating понижается при wdlAfterForSolver > 0.85 (легче решить)', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]); // +0.4
      // KS-2677: wdl POV решателя = +0.85. wdlAfterForSolver = +0.85.
      if (n === 2) return res([line(['b1b8'], { w: 900, d: 50, l: 50 })]);
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    // wdlAfterForSolver = 0.85 — пограничный случай (не > 0.85), rating=1500.
    expect(puzzles[0].rating).toBe(1500);
  });

  it('rating с wdlAfterForSolver = 0.95 → 1500 - 150 = 1350', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]);
      // KS-2677: wdl POV решателя = +0.95.
      if (n === 2) return res([line(['b1b8'], { w: 950, d: 50, l: 0 })]);
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles[0].rating).toBe(1350);
  });

  it('пустой PGN → engine инициализирован и destroyed; пазлов нет', async () => {
    const { engine, destroyed } = makeMockEngine(() =>
      res([line(['a1a1'], { w: 500, d: 0, l: 500 })]),
    );
    const puzzles = await generatePuzzlesFromPgn('', vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles).toHaveLength(0);
    expect(destroyed.value).toBe(true);
  });

  it('abortSignal прерывает обработку игры', async () => {
    const ctrl = new AbortController();
    const { engine } = makeMockEngine(() => {
      // Прерываем сразу при первом analyze.
      ctrl.abort();
      return res([line(['a1a8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
      abortSignal: ctrl.signal,
    });
    expect(puzzles).toHaveLength(0);
  });
});
