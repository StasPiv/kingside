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

describe('generatePuzzlesFromPgn KS-2584 / KS-3137 — WDL-алгоритм', () => {
  it('детектирует blunder при wdlBefore=+0.7 / wdlAfter=+0.7 (POV решателя) → deltaW=0.85 ≥ 0.6 → принять', async () => {
    let beforeAnalyzed = 0;
    let afterAnalyzed = 0;
    const { engine } = makeMockEngine((call, _idx) => {
      // KS-3137: оба wdl POV side-to-move (UCI). evaluateBlunder сам
      // вычислит deltaW = (before.w − after.l)/1000 и deltaD по разнице
      // draw-доли. Для пары (W=850/L=150) ↔ (W=850/L=150):
      //   deltaW = (850 − 150)/1000 = 0.7 ⇒ ≥ 0.6 (триггер по W),
      //   W_after_for_solver = 850/1000 = 0.85 ≥ minWAfterForSolver(0.5) ✓
      if (beforeAnalyzed === 0 && afterAnalyzed === 0) {
        beforeAnalyzed = 1;
        return res([line(['a1a8'], { w: 850, d: 0, l: 150 })]);
      }
      if (beforeAnalyzed === 1 && afterAnalyzed === 0) {
        afterAnalyzed = 1;
        return res([line(['b1b8'], { w: 850, d: 0, l: 150 })]);
      }
      // Остальные позиции — «нет блaндера».
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
    // KS-3137: вместо свёрнутого `blunderDelta` пишем дельты по отдельности
    // и триггер. deltaW = (850 − 150)/1000 = 0.7, deltaD = 0.
    expect(p.sourceMetadata?.deltaW).toBeCloseTo(0.7, 2);
    expect(p.sourceMetadata?.deltaD).toBeCloseTo(0, 2);
    expect(p.sourceMetadata?.blunderTrigger).toBe('W');
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

  it('KS-3140: «реализуй перевес» — wdlBefore=+0.97 БОЛЬШЕ не отбрасывается по skipDecided, проходит как зевок если есть deltaW', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      // KS-3140: даже если позиция изначально «выигрышная» (W=970/L=0,
      // |signed|=0.97 > 0.95), это НЕ повод пропускать — именно такие
      // позиции и образуют пазлы «реализуй перевес» когда блaндер
      // упускает выигрыш.
      if (n === 1) return res([line(['a1a8'], { w: 970, d: 30, l: 0 })]);
      if (n === 2) {
        // wdlAfter POV решателя: W=0, D=900, L=100. Зевок упустил победу в ничью.
        //   deltaW = (970 − 100)/1000 = 0.87 ≥ 0.6 ✓ (триггер по W)
        //   W_after + D_after = 0 + 0.9 = 0.9 ≥ 0.5 ✓ (единый after-фильтр KS-3140)
        return res([line(['b1b8'], { w: 0, d: 900, l: 100 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    expect(puzzles[0].sourceMetadata?.deltaW).toBeCloseTo(0.87, 2);
    expect(puzzles[0].sourceMetadata?.blunderTrigger).toBe('W');
  });

  it('KS-3140: lowWplusDAfter drop — триггер по D, но solver в проигрышной позиции → drop', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) {
        // wdlBefore POV блaндера: W=0, D=900, L=100 (почти-ничья).
        return res([line(['a1a8'], { w: 0, d: 900, l: 100 })]);
      }
      if (n === 2) {
        // wdlAfter POV решателя: W=0, D=200, L=800.
        // deltaW = (0 − 800)/1000 = -0.8 — НЕ триггер по W.
        // deltaD = (900 − 200)/1000 = 0.7 ≥ 0.6 — триггер по D ✓
        // W+D_after = (0+200)/1000 = 0.2 < 0.5 → drop lowWplusDAfter.
        // Решающий упустил ничью И оказался в проигрышной позиции —
        // позиция не годится как пазл «спасение в ничью».
        return res([line(['b1b8'], { w: 0, d: 200, l: 800 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles).toHaveLength(0);
  });

  it('notBlunder drop — обе дельты < 0.6 → drop', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      // (W=600,L=400) → (W=600,L=400):
      //   deltaW = (600 − 400)/1000 = 0.2 < 0.6
      //   deltaD = 0 < 0.6 — ни один триггер не сработал.
      if (n === 1) return res([line(['a1a8'], { w: 600, d: 0, l: 400 })]);
      if (n === 2) return res([line(['b1b8'], { w: 600, d: 0, l: 400 })]);
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles).toHaveLength(0);
  });

  it('KS-3137: триггер по D (упустил ничью) — drawCheck захватывает позицию', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) {
        // Блaндер POV — почти ничья: W=200, D=700, L=100.
        // wdlSigned = (200 − 100)/1000 = 0.1, |signed| < 0.95 — не decided.
        return res([line(['a1a8'], { w: 200, d: 700, l: 100 })]);
      }
      if (n === 2) {
        // После хода: решатель видит W=600, D=50, L=350.
        //   deltaW = (200 − 350)/1000 = -0.15 < 0.6 — НЕ триггер по W.
        //   deltaD = (700 − 50)/1000 = 0.65 ≥ 0.6 — триггер по D ✓.
        //   W+D_after = 0.6 + 0.05 = 0.65 ≥ minWPlusDAfterForSolver (0.5) ✓.
        return res([line(['b1b8'], { w: 600, d: 50, l: 350 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    expect(puzzles[0].sourceMetadata?.blunderTrigger).toBe('D');
    expect(puzzles[0].sourceMetadata?.deltaD).toBeCloseTo(0.65, 2);
  });

  it('mate в score → темы содержат `mate` и `mateInN`', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) {
        return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]); // wdlSigned=+0.4
      }
      if (n === 2) {
        // KS-3137: mate value > 0 на fenAfter (POV решателя) — mate
        // в пользу решающего. `wdlOrMateFallback` собирает Wdl
        // {w:1000, d:0, l:0}. deltaW = (700 − 0)/1000 = 0.7 ≥ 0.6 ✓.
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

  it('KS-3137: deltaWThreshold переопределяется через options', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) {
        // wdlBefore POV блaндера: W=600, L=400 (signed=+0.2 — не decided).
        return res([line(['a1a8'], { w: 600, d: 0, l: 400 })]);
      }
      if (n === 2) {
        // wdlAfter POV решателя: W=800, L=200.
        //   deltaW = (600 − 200)/1000 = 0.4. С override=0.3 проходит триггер,
        //   с дефолтным 0.6 — нет.
        // W_after_for_solver = 0.8 ≥ 0.5 ✓.
        return res([line(['b1b8'], { w: 800, d: 0, l: 200 })]);
      }
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });

    const puzzles = await generatePuzzlesFromPgn(PGN, vi.fn(), {
      engineFactory: () => engine,
      deltaWThreshold: 0.3,
    });
    expect(puzzles.length).toBeGreaterThanOrEqual(1);
    // KS-2955: default depth поднят с 14 до 18 для выравнивания с раннером.
    expect(puzzles[0].sourceMetadata?.depth).toBe(18);
    expect(puzzles[0].sourceMetadata?.deltaW).toBeCloseTo(0.4, 2);
    expect(puzzles[0].sourceMetadata?.blunderTrigger).toBe('W');
  });

  it('crushing-метка при wdlAfterForSolver ≥ 0.95', async () => {
    let n = 0;
    const { engine } = makeMockEngine(() => {
      n++;
      if (n === 1) return res([line(['a1a8'], { w: 700, d: 0, l: 300 })]); // wdlSigned=+0.4
      // KS-3137: wdl POV решателя = +0.97 (W=970, D=30, L=0).
      //   deltaW = (700 − 0)/1000 = 0.7 ≥ 0.6 ✓.
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

  // ── KS-2683 ─────────────────────────────────────────────────────────
  it('KS-2683: PGN из chess.com с {clk}/{csl}/{cal}/NAG/вариантами/* парсится без ошибок', async () => {
    const chesscomPgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.05.09"]
[Round "-"]
[White "RafaellDiamante"]
[Black "PozitiFF_Chess"]
[Result "0-1"]
[WhiteElo "2387"]
[BlackElo "2467"]

1. e4 {[%clk 0:02:59.5]} c5 {[%clk 0:03:00.6]} 2. Nf3 {[%clk 0:03:00.2]} Nc6 {[%clk 0:03:02]} 3. Bb5 {[%clk 0:03:00.9]} g6 $1 {По рекомендации чешских мастеров [%clk 0:03:02.6]} (3... e6 $6 {Сомнительно, белые получают игровую позицию с давлением [%csl Rd6] [%cal Ge4e5]}) 4. O-O {[%clk 0:03:01.2]} Bg7 {[%clk 0:03:03.8]} 5. Re1 {[%clk 0:03:02.4]} Nf6 {[%clk 0:03:05]} 6. e5 {[%clk 0:03:03.2]} Nd5 {[%clk 0:03:04.4]} 7. Nc3 {[%clk 0:03:04.4]} Nxc3 {[%clk 0:02:57.4]} 8. bxc3 {[%clk 0:03:06.3]} O-O {[%clk 0:02:57.7]} 9. d4 {[%clk 0:03:07]} cxd4 {[%clk 0:02:58.1]} 10. cxd4 {[%clk 0:03:08.4]} d5 {[%clk 0:02:58.9]} 11. a4 {[%clk 0:03:03.9]} Bg4 {[%clk 0:02:59.1]} 12. Bxc6 {[%clk 0:02:57.7]} bxc6 {[%clk 0:02:58.9]} 13. Ba3 {[%clk 0:02:59.1]} Re8 {[%clk 0:02:51.9]} 14. h3 {[%clk 0:02:59.2]} Bf5 {[%clk 0:02:45.3]} 15. Nd2 {[%clk 0:02:57.8]} f6 {[%clk 0:02:17.3]} 16. f4 {[%clk 0:02:55.8]} fxe5 {[%clk 0:02:13.3]} 17. fxe5 {[%clk 0:02:56]} e6 {[%clk 0:01:51.5]} 18. Nb3 {[%clk 0:02:55.1]} Qh4 {[%clk 0:01:44.8]} 19. Qd2 {[%clk 0:02:39.4]} Bh6 {[%clk 0:01:39.6]} 20. Qc3 {[%clk 0:02:27.6]} Be4 {[%clk 0:01:28.3]} 21. Nc5 {[%clk 0:02:21.3]} Bf5 {[%clk 0:00:46.3]} 22. g4 {[%clk 0:02:08.1]} Bxg4 {[%clk 0:00:41.9]} 23. hxg4 {[%clk 0:02:10]} Qxg4+ {[%clk 0:00:41.3]} 24. Kh1 {[%clk 0:01:57]} Rf8 {[%clk 0:00:39.2]} 25. Rf1 {[%clk 0:01:04.6]} Bf4 {[%clk 0:00:39.5]} 26. Rf2 {[%clk 0:00:42.9]} Rf5 {[%clk 0:00:38.4]} 27. Rg2 {[%clk 0:00:40.4]} Rh5+ {[%clk 0:00:34.2]} 28. Kg1 {[%clk 0:00:41.4]} Bh2+ {[%clk 0:00:35.1]} 29. Kf1 {[%clk 0:00:42.1]} Rf8+ {[%clk 0:00:36.1]} 30. Rf2 {[%clk 0:00:43.2]} Qg1+ {[%clk 0:00:35.5] [%csl Rf1]} *`;
    let analyzeCalls = 0;
    const { engine } = makeMockEngine(() => {
      analyzeCalls++;
      // «Нет blunder» — нулевая дельта, ни один пазл не пройдёт.
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });
    // Без exception — это главный acceptance из задачи.
    const puzzles = await generatePuzzlesFromPgn(chesscomPgn, vi.fn(), {
      engineFactory: () => engine,
    });
    // Genераtор должен дойти до анализа (analyzeCalls > 0) — это
    // подтверждает, что history успешно прошлась mid-game и engine.analyze
    // вызывался. Конкретное число пазлов не валидируем — без
    // реального Stockfish blunder-сценарий невоспроизводим.
    expect(analyzeCalls).toBeGreaterThan(0);
    expect(puzzles).toEqual([]);
  });

  it('KS-2683: вложенные варианты ((…)) корректно вырезаются', async () => {
    // Чисто вложенный вариант. Базовый PGN с длинным main line, чтобы
    // дойти до startPly=20.
    const pgnWithNestedVar = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "*"]

1. e4 (1. d4 (1. c4 d5) Nf6) e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nbd2 Bb7 12. Bc2 Re8 *`;
    const { engine } = makeMockEngine(() => {
      return res([line(['c1c8'], { w: 500, d: 0, l: 500 })]);
    });
    // Без exception → strip отработал корректно даже с вложенным `(())`.
    const puzzles = await generatePuzzlesFromPgn(pgnWithNestedVar, vi.fn(), {
      engineFactory: () => engine,
    });
    expect(puzzles).toEqual([]);
  });
});
