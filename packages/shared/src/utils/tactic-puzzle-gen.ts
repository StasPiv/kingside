/**
 * KS-4338 / ADR-135 §2.3 — общий слой генерации «tactic puzzle» на
 * Maia-difficulty. Запускается одинаково на сервере (с фиксированным
 * `go nodes` бюджетом) и в браузере (с `go infinite` потоковым обновлением
 * сложности). Здесь — чистая логика отбора без знания о Stockfish-pool,
 * ONNX-сессии, БД, кеше. I/O в это пакет не попадает.
 *
 * Концепт пазла (см. ADR-135 §1):
 *   * на стартовой FEN существует ровно один сильный ход на двух
 *     независимых проходах движка (предварительный + верифицирующий);
 *   * Maia-3 на ELO `maiaElo` даёт сильному набору суммарную вероятность
 *     < (1 − `difficultyMin`) — то есть человек уровня `maiaElo` обычно
 *     этот ход не находит;
 *   * лучший ход не проигрывает (`L ≤ loseMax`);
 *   * зазор по expected score между лучшим и вторым `≥ gapMin`;
 *   * лучший ход на обоих проходах совпадает.
 *
 * Старый `puzzle-gen-pipeline.ts` (blunder-триггер, reactive/preventive)
 * сосуществует с этим модулем до миграции фронта (см. ADR-135 §2.6 / T7).
 */
import { Chess } from 'chess.js';
import type { Wdl } from './wdl.js';

// ─── Settings + defaults ─────────────────────────────────────────────

/**
 * Параметры алгоритма. Все пороги собраны явно — клиент и сервер могут
 * крутить независимо (например, клиент не использует `sfMainNodes` /
 * `sfVerifyNodes`, потому что в браузере SF идёт в `go infinite`).
 */
export interface TacticPuzzleGenSettings {
  /** Минимальный 1-based ply начала поиска. Отсекает дебют. */
  startPly: number;
  /** Бюджет предварительного прохода Stockfish (узлы). */
  sfMainNodes: number;
  /** Бюджет верифицирующего прохода Stockfish (узлы). */
  sfVerifyNodes: number;
  /** `MultiPV` для обоих проходов. */
  sfMultiPv: number;
  /** Целевой ELO Maia. И белые, и чёрные оцениваются на этом уровне. */
  maiaElo: number;
  /** Порог «эквивалентности» по expected score. Сильный набор — все,
   *  у кого `bestE − E ≤ epsEquiv`. */
  epsEquiv: number;
  /** Минимально допустимая Maia-сложность сильного набора:
   *  `(1 − Σ policy[strongSet]) > difficultyMin`. */
  difficultyMin: number;
  /** Максимально допустимая вероятность проигрыша лучшим ходом. */
  loseMax: number;
  /** Минимально допустимый зазор `bestE − secondE` на верифицирующем
   *  проходе. */
  gapMin: number;
}

/**
 * Серверные дефолты ADR-135 §1. Прототип `/tmp/run-combined.mjs`,
 * подтверждено на трёх партиях (Pivovartsev–Hoffmann, Erigaisi–Theodorou,
 * Bogdanov–Pivovartsev). Финальные значения уточнятся на T5 после
 * пробного прогона 100–500 партий.
 */
export const TACTIC_PUZZLE_GEN_DEFAULTS: TacticPuzzleGenSettings = {
  startPly: 20,
  sfMainNodes: 1_000_000,
  sfVerifyNodes: 10_000_000,
  sfMultiPv: 10,
  maiaElo: 2400,
  epsEquiv: 0.02,
  difficultyMin: 0.9,
  loseMax: 0.5,
  gapMin: 0.2,
};

// ─── Engine + Maia контракты ────────────────────────────────────────

/**
 * Минимальная строка MultiPV-вывода Stockfish, нужная отбору. Сервер
 * адаптирует свою `MultiPvLine`, клиент — обёртку над WASM engine-adapter.
 *
 *   - `move` — UCI первого хода PV;
 *   - `E` — expected score POV side-to-move (формула lichess по cp или
 *     `(W + D/2)/1000` по WDL — конкретная свёртка остаётся на адаптере);
 *   - `wdl` — нужен, чтобы посчитать вероятность проигрыша L. Если
 *     движок не отдал WDL (старые SF при mate), адаптер обязан
 *     подставить mate-fallback `{w:1000,d:0,l:0}` / `{0,0,1000}`;
 *     иначе позиция отбраковывается как `engineError`.
 */
export interface TacticSfLine {
  move: string;
  E: number;
  wdl: Wdl | null;
}

export interface TacticSfEngine {
  analyze(
    fen: string,
    multiPV: number,
    nodes: number,
    ctx?: { label?: string; signal?: AbortSignal },
  ): Promise<{ lines: TacticSfLine[]; maxDepth: number }>;
}

export interface MaiaPolicySource {
  predictMoves(
    fen: string,
    eloW: number,
    eloB: number,
  ): Promise<{ policy: Array<{ move: string; probability: number }> }>;
}

// ─── Один шаг анализа ───────────────────────────────────────────────

/**
 * Абстрактный шаг: позиция, на которой ищем пазл. На сервере шаги
 * собираются `replayPgnForTacticPuzzles`; в браузере — генерируются на
 * каждом полуходе пользователя из текущего FEN.
 */
export interface TacticPlyStep {
  /** 1-based ply от начала партии (на сервере) или произвольный счётчик
   *  на клиенте. Идёт в `sourceMoveNum` для отладки. */
  ply: number;
  /** FEN позиции — стартовая FEN потенциального пазла. side-to-move в
   *  FEN = solver. */
  fen: string;
  /** Позиция уже терминальна (мат/пат/3-fold/50-move). Шаг отбрасывается. */
  isGameOver: boolean;
}

export interface TacticPuzzleCandidate {
  ply: number;
  fen: string;
  /** side-to-move в `fen`. */
  solverSide: 'w' | 'b';
  /** UCI единственного сильного хода (решение пазла). */
  bestMoveUci: string;
  /** Expected score лучшего хода на верифицирующем проходе. */
  bestE: number;
  /** Expected score второго по силе хода на верифицирующем проходе. */
  secondE: number;
  /** `bestE − secondE` на верифицирующем проходе. */
  gap: number;
  /** WDL лучшего хода POV solver. */
  wdl: Wdl;
  /** `1 − Σ policy[strongSet]` по Maia на стартовой позиции. */
  difficulty: number;
  /** Достигнутая глубина движка на верифицирующем проходе. */
  depth: number;
}

// KS-4368 / KS-4367. Поле `objective` и CONVERT_THRESHOLD удалены.
// Семантика «реализуй перевес / удержи равенство» оказалась
// ad-hoc эвристикой и не используется UI (см. пересмотр ADR-135 §2.3,
// коммит f8fa746). Логика отбора кандидата теперь не зависит от bestE
// в этой части — решает только `gapMin` / `loseMax` / `difficultyMin`.

export type TacticPuzzleRejectReason =
  | 'gameOver'
  | 'engineError'
  | 'noEngineLines'
  | 'notUniqueStrongMain'
  | 'maiaInferenceFailed'
  | 'maiaLowDifficulty'
  | 'notUniqueStrongVerify'
  | 'bestMoveMismatch'
  | 'bestMoveLoses'
  | 'gapTooSmall';

export type AnalyzePlyTacticResult =
  | { kind: 'accepted'; candidate: TacticPuzzleCandidate }
  | { kind: 'rejected'; reason: TacticPuzzleRejectReason };

function sideToMoveFromFen(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

function uniqueStrongMove(
  lines: TacticSfLine[],
  epsEquiv: number,
): { strong: TacticSfLine[]; bestE: number } {
  const bestE = Math.max(...lines.map((l) => l.E));
  const strong = lines.filter((l) => bestE - l.E <= epsEquiv);
  return { strong, bestE };
}

/**
 * Анализ одной позиции на пригодность пазлу. Последовательность строго
 * соответствует прототипу `/tmp/run-combined.mjs` и ADR-135 §1:
 *
 *   1) `gameOver` — отсев терминальных позиций.
 *   2) Main pass SF (`sfMainNodes`, `sfMultiPv`) → `notUniqueStrongMain`
 *      если сильных ходов > 1.
 *   3) Maia inference → `maiaLowDifficulty` если `difficulty ≤ difficultyMin`.
 *   4) Verify pass SF (`sfVerifyNodes`, `sfMultiPv`) → `notUniqueStrongVerify`.
 *   5) `bestMoveMismatch` — лучший ход двух проходов не совпал.
 *   6) `bestMoveLoses` — `L > loseMax` у лучшего хода.
 *   7) `gapTooSmall` — `bestE − secondE < gapMin`.
 *
 * Порядок важен: Maia вызывается ДО verify-прохода, чтобы не тратить
 * 10×SF-бюджет на позицию, которую Maia всё равно отбросит.
 */
export async function analyzePlyForTacticPuzzle(
  step: TacticPlyStep,
  sf: TacticSfEngine,
  maia: MaiaPolicySource,
  settings: TacticPuzzleGenSettings,
  ctx?: { signal?: AbortSignal; gameId?: string },
): Promise<AnalyzePlyTacticResult> {
  if (step.isGameOver) return { kind: 'rejected', reason: 'gameOver' };

  const mkLabel = (phase: 'main' | 'verify'): string =>
    ctx?.gameId
      ? `tactic:${phase} g=${ctx.gameId} ply=${step.ply}`
      : `tactic:${phase} ply=${step.ply}`;

  // (2) Main pass
  let mainLines: TacticSfLine[];
  try {
    const r = await sf.analyze(
      step.fen,
      settings.sfMultiPv,
      settings.sfMainNodes,
      { label: mkLabel('main'), signal: ctx?.signal },
    );
    mainLines = r.lines;
  } catch {
    return { kind: 'rejected', reason: 'engineError' };
  }
  if (mainLines.length === 0) {
    return { kind: 'rejected', reason: 'noEngineLines' };
  }
  const mainPick = uniqueStrongMove(mainLines, settings.epsEquiv);
  if (mainPick.strong.length !== 1) {
    return { kind: 'rejected', reason: 'notUniqueStrongMain' };
  }

  // (3) Maia inference на стартовой позиции
  let policy: Array<{ move: string; probability: number }>;
  try {
    const res = await maia.predictMoves(
      step.fen,
      settings.maiaElo,
      settings.maiaElo,
    );
    policy = res.policy;
  } catch {
    return { kind: 'rejected', reason: 'maiaInferenceFailed' };
  }
  const policyMap = new Map(policy.map((p) => [p.move, p.probability]));
  const strongProb = mainPick.strong.reduce(
    (sum, l) => sum + (policyMap.get(l.move) ?? 0),
    0,
  );
  const difficulty = 1 - strongProb;
  if (difficulty <= settings.difficultyMin) {
    return { kind: 'rejected', reason: 'maiaLowDifficulty' };
  }

  // (4) Verify pass
  let verifyLines: TacticSfLine[];
  let depth: number;
  try {
    const r = await sf.analyze(
      step.fen,
      settings.sfMultiPv,
      settings.sfVerifyNodes,
      { label: mkLabel('verify'), signal: ctx?.signal },
    );
    verifyLines = r.lines;
    depth = r.maxDepth;
  } catch {
    return { kind: 'rejected', reason: 'engineError' };
  }
  if (verifyLines.length === 0) {
    return { kind: 'rejected', reason: 'noEngineLines' };
  }
  const verifyPick = uniqueStrongMove(verifyLines, settings.epsEquiv);
  if (verifyPick.strong.length !== 1) {
    return { kind: 'rejected', reason: 'notUniqueStrongVerify' };
  }

  // (5) Совпадение лучших ходов двух проходов
  if (verifyPick.strong[0].move !== mainPick.strong[0].move) {
    return { kind: 'rejected', reason: 'bestMoveMismatch' };
  }

  // (6) Не проигрывает: вероятность L лучшего хода ≤ loseMax. Без WDL
  // считать L надёжно нельзя — отдаём engineError (адаптер обязан
  // подставлять mate-fallback).
  const bestLine = verifyPick.strong[0];
  if (!bestLine.wdl) return { kind: 'rejected', reason: 'engineError' };
  const bestL = bestLine.wdl.l / 1000;
  if (bestL > settings.loseMax) {
    return { kind: 'rejected', reason: 'bestMoveLoses' };
  }

  // (7) Зазор bestE − secondE
  const sortedByE = [...verifyLines].sort((a, b) => b.E - a.E);
  const secondE = sortedByE.length >= 2 ? sortedByE[1].E : 0;
  const gap = verifyPick.bestE - secondE;
  if (gap < settings.gapMin) {
    return { kind: 'rejected', reason: 'gapTooSmall' };
  }

  const solverSide = sideToMoveFromFen(step.fen);

  return {
    kind: 'accepted',
    candidate: {
      ply: step.ply,
      fen: step.fen,
      solverSide,
      bestMoveUci: bestLine.move,
      bestE: verifyPick.bestE,
      secondE,
      gap,
      wdl: bestLine.wdl,
      difficulty,
      depth,
    },
  };
}

// ─── PGN replay → TacticPlyStep[] ───────────────────────────────────

/**
 * Проигрывает PGN, собирает по одному шагу на каждый полуход с
 * `ply ≥ startPly`. FEN — состояние ДО сыгранного хода (на этой позиции
 * solver ищет ход). `isGameOver` — состояние на текущем FEN; в нормальном
 * PGN всегда `false` для шагов из истории (раз ход был сыгран), но
 * проверяем явно, чтобы не падать на покалеченных потоках.
 */
export function replayPgnForTacticPuzzles(
  pgn: string,
  startPly: number,
):
  | { steps: TacticPlyStep[]; headers: Record<string, string> }
  | { error: string } {
  let chess: Chess;
  try {
    chess = new Chess();
    chess.loadPgn(pgn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `loadPgn failed: ${msg}` };
  }
  const headers = (chess.getHeaders() ?? {}) as Record<string, string>;
  const history = chess.history({ verbose: true });

  const replay = new Chess();
  const steps: TacticPlyStep[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;
    const fen = replay.fen();
    const isGameOver = replay.isGameOver();
    try {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      return { error: `replay move failed at ply=${ply}` };
    }
    if (ply < startPly) continue;
    steps.push({ ply, fen, isGameOver });
  }
  return { steps, headers };
}

// ─── processGameForTacticPuzzles ────────────────────────────────────

export type TacticDropStats = Record<TacticPuzzleRejectReason, number>;

export function newTacticDropStats(): TacticDropStats {
  return {
    gameOver: 0,
    engineError: 0,
    noEngineLines: 0,
    notUniqueStrongMain: 0,
    maiaInferenceFailed: 0,
    maiaLowDifficulty: 0,
    notUniqueStrongVerify: 0,
    bestMoveMismatch: 0,
    bestMoveLoses: 0,
    gapTooSmall: 0,
  };
}

export interface ProcessGameForTacticPuzzlesResult {
  candidates: TacticPuzzleCandidate[];
  stats: { positionsAnalyzed: number; drops: TacticDropStats };
  headers: Record<string, string>;
}

/**
 * High-level: PGN → массив кандидатов + статистика отсева. Все позиции
 * анализируются последовательно — параллелизм между ply внутри партии
 * shared не диктует, его строит обёртка через `Promise.all` или очередь
 * движка. Это намеренно (см. комментарий к `analyzePlyForBlunder` в
 * старом pipeline).
 *
 * Возвращает `{ error }` при невалидном PGN — не бросает, чтобы вызывающий
 * worker мог посчитать партию как drop и продолжить.
 */
export async function processGameForTacticPuzzles(args: {
  pgn: string;
  sf: TacticSfEngine;
  maia: MaiaPolicySource;
  settings: TacticPuzzleGenSettings;
  signal?: AbortSignal;
  gameId?: string;
}): Promise<ProcessGameForTacticPuzzlesResult | { error: string }> {
  const replay = replayPgnForTacticPuzzles(args.pgn, args.settings.startPly);
  if ('error' in replay) return { error: replay.error };

  const candidates: TacticPuzzleCandidate[] = [];
  const drops = newTacticDropStats();
  let positionsAnalyzed = 0;

  for (const step of replay.steps) {
    if (args.signal?.aborted) break;
    const result = await analyzePlyForTacticPuzzle(
      step,
      args.sf,
      args.maia,
      args.settings,
      { signal: args.signal, gameId: args.gameId },
    );
    if (result.kind === 'accepted') {
      positionsAnalyzed++;
      candidates.push(result.candidate);
      continue;
    }
    drops[result.reason]++;
    // engineError / maiaInferenceFailed — позиция не была честно
    // проанализирована (внешний сбой), её не считаем в analyzed.
    // gameOver — позиция вообще не анализировалась (выбита на гейте).
    if (
      result.reason !== 'engineError' &&
      result.reason !== 'maiaInferenceFailed' &&
      result.reason !== 'gameOver'
    ) {
      positionsAnalyzed++;
    }
  }

  return {
    candidates,
    stats: { positionsAnalyzed, drops },
    headers: replay.headers,
  };
}
