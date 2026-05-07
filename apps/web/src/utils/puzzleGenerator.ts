import { Chess } from 'chess.js';
import {
  PUZZLE_GEN_DEFAULTS,
  wdlSigned,
  wdlSignedFromInfo,
  type Wdl,
} from '@kingside/shared';
import type { EngineAdapter, BridgeConfig, InfoLine } from './engineAdapter';
import { WasmEngineAdapter, BridgeEngineAdapter } from './engineAdapter';

export type { BridgeConfig };

/**
 * KS-2584 / ADR-050 §2.1, §3 #5 — клиентский генератор пазлов на
 * WDL-алгоритме (зеркало серверного `tactic-worker/puzzle-generator`).
 *
 * Прежний CP-алгоритм (gap ≥ 50 cp + эвристики hanging/attacked-by-lesser/
 * undefended) переехал в исторический контекст: он находил «уникальные
 * лучшие ходы» по cp-разнице, что плохо коррелирует с реальной потерей
 * шансов на победу. WDL-алгоритм ловит «зевок» как падение
 * вероятности победы (W − L) ≥ 0.6 от лица сходившего.
 *
 * Псевдокод (исходник в ADR-050 §2.1):
 *
 *   для каждой позиции (ply ≥ startPly):
 *     fenBefore, playedUci = ход партии
 *     [line1, line2] = analyze(fenBefore, depth, multiPV=2)
 *     wdlBefore = wdlSignedFromInfo(line1.wdl, line1.score)
 *     if line1.pv[0] === playedUci → drop:samePv1
 *     if |wdlBefore| > 0.95         → drop:decided
 *     fenAfter = apply(playedUci)
 *     if isGameOver(fenAfter)       → drop:gameOver
 *     [a1, a2] = analyze(fenAfter, depth, multiPV=2)
 *     wdlAfter (POV соперника) = wdlSignedFromInfo(a1.wdl, a1.score)
 *     wdlAfterForSolver = -wdlAfter
 *     blunderΔ = wdlBefore + wdlAfterForSolver
 *     if blunderΔ < blunderDelta(0.6)               → drop:notBlunder
 *     if wdlAfterForSolver < minWdlAfterBlunder(0.5)→ drop:lowWdlAfterBlunder
 *     (опц.) solvability check (halfMovesN=6 SF-vs-SF) → drop:solvabilityFailed
 *     accept → play-vs-engine puzzle, isPublic=false
 *
 * Все WDL-пороги — общий `PUZZLE_GEN_DEFAULTS` из `@kingside/shared`
 * (KS-2583 / KS-2579-#4). При отсутствии поля `info.wdl` (старая
 * сборка Stockfish без UCI_ShowWDL) `wdlSignedFromInfo` падает на
 * mate-фоллбек ±1, иначе возвращает `null` — позиция skip:noWdl.
 *
 * Регрессии cp-алгоритма больше нет: `gapThreshold`/`maxSecondCp`/
 * `topSpread`/`acceptedMoves`/`skipHangingCapture`/`skipAttackedByLesser`/
 * `skipUndefendedAfterMove`/`evalGrowth`/cp-`classifyThemes`/
 * `estimateRating` удалены. UI-поля, читающие старые ключи, остаются в
 * `PuzzleGeneratorModal` до #6 (KS-2584 explicitly не трогает UI). Для
 * этой совместимости старые поля помечены `@deprecated` и игнорируются
 * самим алгоритмом.
 */

export type SourceMetadata = {
  white?: string;
  black?: string;
  event?: string;
  date?: string;
  result?: string;
  // KS-2584: WDL-метаданные пазла (зеркало серверного DTO `playVsEngine`).
  blunderMove?: string;
  wdlBeforeBlunder?: number;
  wdlAfterBlunder?: number;
  blunderDelta?: number;
  halfMovesN?: number;
  winThreshold?: number;
  failThreshold?: number;
  depth?: number;
};

export type GeneratedPuzzleData = {
  fen: string;
  /**
   * KS-2584: для play-vs-engine пазлов solution-линия не известна
   * заранее (соперник = Stockfish, ход юзера определяется в рантайме).
   * Оставляем пустую строку — backend контракт допускает.
   */
  moves: string;
  /** @deprecated KS-2584: не используется в play-vs-engine. */
  acceptedMoves?: string;
  rating: number;
  /**
   * KS-2584: «насколько большой перевес после правильного хода»
   * (для UX: 0..100). До KS-2584 — gap в сантипешках между линиями.
   */
  gap: number;
  themes: string;
  sourceType: string;
  sourceId: string | null;
  sourceMoveNum: number;
  sourceMetadata?: SourceMetadata;
  /** KS-2584: единственный поддерживаемый mode после WDL-pivot. */
  solutionMode: 'play-vs-engine';
  /**
   * KS-2584: важно — клиент создаёт пазлы как DRAFT (`isPublic: false`),
   * чтобы автор сначала сам мог пройти и оценить. Backend whitelist
   * KS-2560 уважает поле.
   */
  isPublic: false;
};

export type GenerationProgress = {
  gameIndex: number;
  totalGames: number;
  positionIndex: number;
  totalPositions: number;
  puzzlesFound: number;
};

export interface PuzzleGenSettings {
  /** Глубина SF-анализа (полуходов). По умолчанию 14. */
  depth: number;
  /**
   * Минимальная разница `wdlBefore + wdlAfterForSolver` ([0..2]),
   * чтобы считать ход блaндером. По умолчанию `PUZZLE_GEN_DEFAULTS.
   * blunderDelta` = 0.6.
   */
  blunderDelta: number;
  /**
   * Включить halfMovesN=6 SF-vs-SF проверку решаемости пазла. На
   * MVP по умолчанию выключено (тяжёлый отдельный анализ × N полуходов).
   */
  solvabilityCheck: boolean;
}

export const DEFAULT_PUZZLE_GEN_SETTINGS: PuzzleGenSettings = {
  depth: 14,
  blunderDelta: PUZZLE_GEN_DEFAULTS.blunderDelta,
  solvabilityCheck: false,
};

const MULTI_PV = 2;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * KS-2584: упрощённый client-side `computeTagsClient`. Серверный аналог
 * — `apps/tactic-worker/src/puzzle-generator` `computeTagsServer`. Без
 * cp-эвристик; темы выводятся из WDL и количества фигур на доске.
 */
function computeTagsClient(
  fenAfter: string,
  wdlAfterForSolver: number,
  isMate: boolean,
  mateDist: number,
): string[] {
  const themes: string[] = ['playVsEngine'];
  if (isMate) {
    themes.push('mate');
    if (mateDist <= 5) themes.push('mateInN');
    if (mateDist === 1) themes.push('mateIn1');
    else if (mateDist === 2) themes.push('mateIn2');
    else if (mateDist === 3) themes.push('mateIn3');
  }
  if (wdlAfterForSolver >= 0.95) themes.push('crushing');
  else if (wdlAfterForSolver >= 0.5) themes.push('advantage');

  try {
    const chess = new Chess(fenAfter);
    const pieces = chess.board().flat().filter(Boolean).length;
    if (pieces <= 7) themes.push('endgame');
  } catch {
    /* fenAfter может быть невалиден — без endgame-метки */
  }
  return themes;
}

/**
 * KS-2584: упрощённый `computeStartingRating` (ADR-044 §3.5 — точная
 * формула опирается на Elo игроков, чего на клиенте нет). MVP: 1500
 * базовый, −150 если позиция сильно разгромная (легче решить, нужно
 * ниже). `clamp(800, 2000)` гарантирует разумный диапазон.
 */
function computeStartingRating(wdlAfterForSolver: number): number {
  const base = 1500 - (wdlAfterForSolver > 0.85 ? 150 : 0);
  return clamp(base, 800, 2000);
}

/**
 * Solvability-check (halfMovesN=6 SF-vs-SF от `fenAfter`). Решающий
 * ходит по `analyze(currentFen, depth, multiPv=1)`. На каждом ходу
 * решающего проверяем `wdl ≥ failThreshold`; в конце требуем `wdl ≥
 * winThreshold`. Зеркало `apps/tactic-worker/src/puzzle-generator/
 * generator-pipeline.ts`-passa.
 */
async function solvabilityPasses(
  engine: EngineAdapter,
  fenAfter: string,
  depth: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const halfMoves = PUZZLE_GEN_DEFAULTS.halfMovesN;
  const winT = PUZZLE_GEN_DEFAULTS.winThreshold;
  const failT = PUZZLE_GEN_DEFAULTS.failThreshold;
  let chess: Chess;
  try {
    chess = new Chess(fenAfter);
  } catch {
    return false;
  }
  // На fenAfter сторона на ходу — это решающий (соперник сходившего).
  const solverColor = chess.turn();
  let lastWdlForSolver = 0;
  for (let half = 0; half < halfMoves; half++) {
    if (abortSignal?.aborted) return false;
    if (chess.isGameOver()) {
      // checkmate решающим — успех; иначе draw — провал.
      if (chess.isCheckmate()) {
        const winnerIsSolver = chess.turn() !== solverColor;
        return winnerIsSolver && lastWdlForSolver >= winT;
      }
      return false;
    }
    const result = await engine.analyze(chess.fen(), depth, 1);
    if (result.lines.length === 0) return false;
    const line = result.lines[0];
    const sideOnMove = chess.turn();
    const wdl = wdlSignedFromInfo(line.wdl, line.score);
    if (wdl === null) return false;
    const wdlForSolver = sideOnMove === solverColor ? wdl : -wdl;
    if (sideOnMove === solverColor) {
      lastWdlForSolver = wdlForSolver;
    }
    if (wdlForSolver < failT) return false;
    const move = line.pv[0];
    if (!move) return false;
    try {
      const piece = move.length > 4 ? move[4] : undefined;
      const moved = chess.move({
        from: move.slice(0, 2),
        to: move.slice(2, 4),
        promotion: piece,
      });
      if (!moved) return false;
    } catch {
      return false;
    }
  }
  return lastWdlForSolver >= winT;
}

/** Извлечь WDL_signed (POV side-to-move) из info-строки. */
function extractWdlSigned(line: InfoLine): number | null {
  return wdlSignedFromInfo(line.wdl ?? null, line.score);
}

export async function generatePuzzlesFromPgn(
  pgn: string,
  onProgress: (progress: GenerationProgress) => void,
  options: Partial<PuzzleGenSettings> & {
    abortSignal?: AbortSignal;
    bridgeConfig?: BridgeConfig;
    /**
     * KS-2584: фабрика движка для unit-тестов (mock без WASM-воркера).
     * В production не используется — обычный путь через bridgeConfig
     * или WasmEngineAdapter.
     */
    engineFactory?: () => EngineAdapter;
  } = {},
): Promise<GeneratedPuzzleData[]> {
  const settings: PuzzleGenSettings = {
    ...DEFAULT_PUZZLE_GEN_SETTINGS,
    ...options,
  };
  const { depth, blunderDelta, solvabilityCheck } = settings;
  const { abortSignal, bridgeConfig, engineFactory } = options;
  const startPly = PUZZLE_GEN_DEFAULTS.startPly;
  const skipDecidedThreshold = PUZZLE_GEN_DEFAULTS.skipDecidedWdl;
  const minWdlAfterBlunder = PUZZLE_GEN_DEFAULTS.minWdlAfterBlunder;

  const games = splitPgnIntoGames(pgn);
  console.log(
    '[PuzzleGen] PGN split into',
    games.length,
    'games, input length:',
    pgn.length,
  );
  const puzzles: GeneratedPuzzleData[] = [];

  let engine: EngineAdapter;
  if (engineFactory) {
    engine = engineFactory();
  } else if (bridgeConfig) {
    engine = new BridgeEngineAdapter(bridgeConfig);
  } else {
    engine = new WasmEngineAdapter();
  }

  await engine.init();
  engine.setOption('MultiPV', String(MULTI_PV));
  if (bridgeConfig) {
    engine.setOption('Threads', '16');
    engine.setOption('Hash', '256');
  } else {
    engine.setOption('Threads', '1');
  }

  for (let gi = 0; gi < games.length; gi++) {
    if (abortSignal?.aborted) break;

    const gamePgn = stripPgnAnnotations(games[gi]);
    const chessForReplay = new Chess();
    try {
      chessForReplay.loadPgn(gamePgn);
    } catch (e) {
      console.warn(
        '[PuzzleGen] Failed to parse game',
        gi + 1,
        ':',
        e instanceof Error ? e.message : e,
      );
      continue;
    }

    const metadata: SourceMetadata = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let hMatch;
    while ((hMatch = headerRegex.exec(gamePgn)) !== null) {
      const [, key, value] = hMatch;
      if (key === 'White') metadata.white = value;
      else if (key === 'Black') metadata.black = value;
      else if (key === 'Event') metadata.event = value;
      else if (key === 'Date') metadata.date = value;
      else if (key === 'Result') metadata.result = value;
    }

    const moveHistory = chessForReplay.history({ verbose: true });
    console.log('[PuzzleGen] Game', gi + 1, ':', moveHistory.length, 'moves');

    const fenMatch = gamePgn.match(/\[FEN\s+"([^"]+)"\]/);
    const startFen = fenMatch ? fenMatch[1] : undefined;
    const replay = startFen ? new Chess(startFen) : new Chess();

    // Собираем последовательность (fenBefore, playedUci, moveNum) для
    // каждого хода партии.
    interface Step {
      fenBefore: string;
      playedUci: string;
      moveNum: number;
    }
    const steps: Step[] = [];
    for (let i = 0; i < moveHistory.length; i++) {
      const fenBefore = replay.fen();
      const m = moveHistory[i];
      const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
      steps.push({ fenBefore, playedUci: uci, moveNum: i + 1 });
      replay.move(m.san);
    }

    for (let pi = startPly; pi < steps.length; pi++) {
      if (abortSignal?.aborted) break;

      onProgress({
        gameIndex: gi,
        totalGames: games.length,
        positionIndex: pi,
        totalPositions: steps.length,
        puzzlesFound: puzzles.length,
      });

      const { fenBefore, playedUci, moveNum } = steps[pi];
      const logBase = `[PuzzleGen] pos=${pi} playedUci=${playedUci}`;

      // Skip terminal позиции до анализа.
      let fenAfter = '';
      let isMate = false;
      let mateDist = 0;
      try {
        const checkBefore = new Chess(fenBefore);
        if (checkBefore.isGameOver()) {
          console.log(`${logBase} SKIP:gameOverBefore`);
          continue;
        }
        const moved = checkBefore.move({
          from: playedUci.slice(0, 2),
          to: playedUci.slice(2, 4),
          promotion: playedUci.length > 4 ? playedUci[4] : undefined,
        });
        if (!moved) {
          console.log(`${logBase} SKIP:invalidMove`);
          continue;
        }
        fenAfter = checkBefore.fen();
        if (checkBefore.isGameOver()) {
          console.log(`${logBase} SKIP:gameOverAfter`);
          continue;
        }
      } catch (e) {
        console.warn(
          `${logBase} SKIP:fenError`,
          e instanceof Error ? e.message : e,
        );
        continue;
      }

      // Анализ before.
      let beforeRes;
      try {
        beforeRes = await engine.analyze(fenBefore, depth, MULTI_PV);
      } catch (e) {
        console.error(`${logBase} SKIP:analyzeBeforeError`, e);
        continue;
      }
      if (beforeRes.lines.length === 0) {
        console.log(`${logBase} SKIP:noLinesBefore`);
        continue;
      }
      const lineBefore = beforeRes.lines[0];
      const wdlBefore = extractWdlSigned(lineBefore);
      if (wdlBefore === null) {
        console.log(`${logBase} SKIP:noWdlBefore`);
        continue;
      }
      if (lineBefore.pv[0] === playedUci) {
        console.log(
          `${logBase} wdlBefore=${round3(wdlBefore)} SKIP:samePv1`,
        );
        continue;
      }
      if (Math.abs(wdlBefore) > skipDecidedThreshold) {
        console.log(
          `${logBase} wdlBefore=${round3(wdlBefore)} SKIP:decided`,
        );
        continue;
      }

      // Анализ after (POV соперника сходившего).
      let afterRes;
      try {
        afterRes = await engine.analyze(fenAfter, depth, MULTI_PV);
      } catch (e) {
        console.error(`${logBase} SKIP:analyzeAfterError`, e);
        continue;
      }
      if (afterRes.lines.length === 0) {
        console.log(`${logBase} SKIP:noLinesAfter`);
        continue;
      }
      const lineAfter = afterRes.lines[0];
      const wdlAfter = extractWdlSigned(lineAfter);
      if (wdlAfter === null) {
        console.log(`${logBase} SKIP:noWdlAfter`);
        continue;
      }
      const wdlAfterForSolver = -wdlAfter;
      const blunderΔ = wdlBefore + wdlAfterForSolver;

      if (blunderΔ < blunderDelta) {
        console.log(
          `${logBase} wdlBefore=${round3(wdlBefore)} wdlAfter=${round3(wdlAfter)} blunderΔ=${round3(blunderΔ)} SKIP:notBlunder`,
        );
        continue;
      }
      if (wdlAfterForSolver < minWdlAfterBlunder) {
        console.log(
          `${logBase} wdlBefore=${round3(wdlBefore)} wdlAfter=${round3(wdlAfter)} blunderΔ=${round3(blunderΔ)} SKIP:lowWdlAfterBlunder`,
        );
        continue;
      }

      // Mate check (для тагов).
      if (lineAfter.score.type === 'mate') {
        // mate value на fenAfter — POV соперника. Если он отрицательный —
        // mate в пользу решающего (нам нужен этот случай).
        if (lineAfter.score.value < 0) {
          isMate = true;
          mateDist = Math.abs(lineAfter.score.value);
        }
      }

      if (solvabilityCheck) {
        const ok = await solvabilityPasses(engine, fenAfter, depth, abortSignal);
        if (!ok) {
          console.log(
            `${logBase} blunderΔ=${round3(blunderΔ)} SKIP:solvabilityFailed`,
          );
          continue;
        }
      }

      const themes = computeTagsClient(
        fenAfter,
        wdlAfterForSolver,
        isMate,
        mateDist,
      );
      const rating = computeStartingRating(wdlAfterForSolver);
      console.log(
        `${logBase} wdlBefore=${round3(wdlBefore)} wdlAfter=${round3(wdlAfter)} blunderΔ=${round3(blunderΔ)} ACCEPTED rating=${rating}`,
      );

      puzzles.push({
        fen: fenAfter,
        moves: '',
        rating,
        gap: Math.round(wdlAfterForSolver * 100),
        themes: themes.join(' '),
        sourceType: 'pgn_import',
        sourceId: null,
        sourceMoveNum: moveNum,
        sourceMetadata: {
          ...metadata,
          blunderMove: playedUci,
          wdlBeforeBlunder: round3(wdlBefore),
          wdlAfterBlunder: round3(wdlAfterForSolver),
          blunderDelta: round3(blunderΔ),
          halfMovesN: PUZZLE_GEN_DEFAULTS.halfMovesN,
          winThreshold: PUZZLE_GEN_DEFAULTS.winThreshold,
          failThreshold: PUZZLE_GEN_DEFAULTS.failThreshold,
          depth,
        },
        solutionMode: 'play-vs-engine',
        isPublic: false,
      });
    }
  }

  engine.destroy();
  console.log('[PuzzleGen] Done. Total puzzles:', puzzles.length);
  return puzzles;
}

// ─── PGN-парсер (без изменений из старой версии) ───

/** Strip comments {…}, variations (…), NAG ($1 etc), extra whitespace from PGN movetext */
function stripPgnAnnotations(pgn: string): string {
  const lines = pgn.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('[')) {
      result.push(line);
    } else {
      const cleaned = line
        .replace(/\{[^}]*\}/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\$\d+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      result.push(cleaned);
    }
  }
  return result.join('\n');
}

function splitPgnIntoGames(pgn: string): string[] {
  const games: string[] = [];
  const lines = pgn.split('\n');
  let current: string[] = [];
  let inGame = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[Event ') && current.length > 0 && inGame) {
      games.push(current.join('\n'));
      current = [];
      inGame = false;
    }
    if (trimmed.startsWith('[')) {
      inGame = true;
    }
    current.push(line);
  }

  if (current.length > 0) {
    games.push(current.join('\n'));
  }

  return games.filter((g) => g.trim().length > 0);
}

// ─── Test-only re-exports ───

export { wdlSigned, wdlSignedFromInfo };
export type { Wdl };
