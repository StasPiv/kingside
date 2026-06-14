/**
 * KS-3157 / ADR-070 — Унифицированный pipeline puzzle-генератора в shared.
 *
 * До этой задачи стейдж-based код (replay PGN → pre/post analyze →
 * evaluateBlunder → построение пазла + sourceMetadata) дублировался в
 * двух местах: `apps/tactic-worker/src/puzzle-generator/generator-
 * pipeline.ts` и `apps/web/src/utils/puzzleGenerator.ts`. Обе версии
 * расходились в деталях (POV-инверсия, форма sourceMetadata, теги).
 * После ADR-070 §2.1 — единый pipeline в `@kingside/shared`, обёртки
 * только адаптируют I/O (Stockfish-pool на сервере, WASM/queue на
 * клиенте, БД-insert на сервере, in-memory сбор на клиенте).
 *
 * Также вводится:
 *   - `passesPlayerEloFilter` — server-only фильтр (≥2400 на TWIC),
 *     дефолт 0 = всех принимаем (клиент);
 *   - `buildPuzzlesFromCandidate` — на каждый принятый зевок 1 или 2
 *     пазла:
 *       * реактивный (старое поведение, fen=fenAfter, solver=противник);
 *       * превентивный (новое, fen=fenBefore, solver=зевнувший —
 *         «не упусти позицию»).
 *
 * См. ADR-070 §2.1 — контракты, §2.3 — таблица двойного пазла.
 */
import { Chess } from 'chess.js';
import {
  determinePuzzleObjective,
  evaluateBlunder,
  type BlunderEvalSettings,
  type BlunderTrigger,
  type PuzzleObjective,
} from './puzzle-gen-core.js';
import {
  wdlOrMateFallback,
  wdlSigned,
  type Wdl,
  type WdlScoreInfo,
} from './wdl.js';

// ─── Engine-абстракция ────────────────────────────────────────────

/**
 * Минимальная Stockfish-PV-строка, общая для server (MultiPvLine) и
 * client (InfoLine из engine-adapter). Server-обёртка адаптирует
 * `apps/tactic-worker/.../stockfish.service.ts:MultiPvLine` →
 * `SharedMultiPvLine`. Клиент аналогично, через свой adapter.
 *
 * Перечислены только поля, которые pipeline реально читает:
 *   - `bestMove` — UCI первого хода PV.
 *   - `score` — для mate-fallback (`wdlOrMateFallback`).
 *   - `wdl` — основная оценка (per-mille POV side-to-move).
 */
export interface SharedMultiPvLine {
  bestMove: string;
  score: WdlScoreInfo;
  wdl?: Wdl | null;
}

/**
 * Adapter-интерфейс к движку. Server передаёт обёртку над
 * `EngineApi.analyzePositionWdl(fen, limit, multiPV, label)`; client —
 * над своим WASM-adapter'ом. `ctx.label` опц. — для логирования phase-
 * тэгов в Stockfish-логе (см. KS-2470 phase=defend/attack).
 *
 * `analyze` должен вернуть массив длиной ≥1 (для multiPV=1) или ≥2
 * (для multiPV=2). Пустой массив — `engineError`-drop в обёртке.
 */
export interface PuzzleGenEngine {
  analyze(
    fen: string,
    multiPV: number,
    ctx?: { label?: string; signal?: AbortSignal },
  ): Promise<SharedMultiPvLine[]>;
}

// ─── PlyStep / GameMeta / BlunderCandidate / GeneratedPuzzle ────────

export interface PlyStep {
  /** 1-based ply от начала партии. */
  ply: number;
  /** FEN до хода. side-to-move в нём = зевнувший (preventiveSolver). */
  fenBefore: string;
  /** FEN после хода. side-to-move в нём = противник (reactiveSolver). */
  fenAfter: string;
  /** UCI сыгранного хода (зевок). */
  playedUci: string;
  /** Игра терминальна после применения хода (мат/пат/3-fold/50-move). */
  isGameOverAfter: boolean;
  /** side-to-move на fenAfter — реактивный solver. */
  reactiveSolverSide: 'w' | 'b';
  /** side-to-move на fenBefore — превентивный solver (зевнувший). */
  preventiveSolverSide: 'w' | 'b';
}

export interface GameMeta {
  sourceType: 'archive_game' | 'pgn_import';
  sourceId: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  headers: Record<string, string>;
}

export interface BlunderCandidate {
  step: PlyStep;
  /** Raw WDL POV блaндера на fenBefore. */
  wdlBeforeRaw: Wdl;
  /** Raw WDL POV реактивного solver на fenAfter. */
  wdlAfterRaw: Wdl;
  deltaW: number;
  deltaD: number;
  trigger: BlunderTrigger;
  /** PV1 движка на fenBefore — «правильный ход зевнувшего». */
  pv1BeforeUci: string;
  /** PV1 движка на fenAfter — первый ход реактивного solver. */
  firstMoveAfterUci: string;
}

export type PuzzlePhase = 'preventive' | 'reactive';

export interface GeneratedPuzzle {
  /** Стартовая FEN пазла. */
  fen: string;
  sourceType: 'archive_game' | 'pgn_import';
  sourceId: string | null;
  /** Номер полухода в партии-источнике (для отладки/телеметрии). */
  sourceMoveNum: number;
  themes: string[];
  rating: number;
  solutionMode: 'play-vs-engine';
  puzzlePhase: PuzzlePhase;
  objective: PuzzleObjective;
  /** «Сторона решения» — кто ходит на стартовом fen. */
  solverSide: 'w' | 'b';
  /** Полный JSON-объект для записи в `puzzles.sourceMetadata`. */
  sourceMetadata: Record<string, unknown>;
}

// ─── Settings ────────────────────────────────────────────────────────

/**
 * Полный набор настроек pipeline. Расширяет `BlunderEvalSettings`
 * (deltaW/deltaD/W+D-after) тремя осями ADR-070:
 *   - `minPlayerElo` — фильтр партии по Elo обоих игроков (server: 2400,
 *     client: 0).
 *   - `startPly` — минимальный ply начала поиска зевка (default 20,
 *     PUZZLE_GEN_DEFAULTS).
 *   - `emitPreventivePuzzle` / `emitReactivePuzzle` — какие из двух
 *     пазлов на принятый зевок строить (по умолчанию оба).
 */
export interface PuzzleGenSettings extends BlunderEvalSettings {
  minPlayerElo: number;
  startPly: number;
  emitPreventivePuzzle: boolean;
  emitReactivePuzzle: boolean;
}

// ─── Elo-фильтр ──────────────────────────────────────────────────────

/**
 * ADR-070 §2.2. Фильтр партии по Elo обоих игроков.
 *
 *   - `minPlayerElo === 0` — пропускаем все партии (клиент: пользователь
 *     генерит из своих партий, фильтр не нужен).
 *   - `minPlayerElo > 0` — оба Elo должны быть определены И ≥ `minPlayerElo`.
 *     Если хотя бы один `null`/`undefined` — отбрасываем (нет данных = нет
 *     гарантии качества).
 */
export function passesPlayerEloFilter(
  whiteElo: number | null | undefined,
  blackElo: number | null | undefined,
  minPlayerElo: number,
): boolean {
  if (minPlayerElo <= 0) return true;
  if (whiteElo == null || blackElo == null) return false;
  return whiteElo >= minPlayerElo && blackElo >= minPlayerElo;
}

// ─── PGN replay → PlyStep[] ─────────────────────────────────────────

/**
 * Загружает PGN через chess.js, проигрывает партию и возвращает массив
 * `PlyStep` для каждого полухода `ply ≥ startPly`. Терминальные позиции
 * (мат/пат) отмечаются `isGameOverAfter: true` — обёртка может их
 * пропустить или учесть как `gameOver`-drop.
 *
 * Возвращает либо `{ steps, headers }`, либо `{ error: <message> }` —
 * для невалидных PGN. headers — Seven Tag Roster (плюс ELO) для
 * UI-метаданных пазла («Из партии»).
 */
export function replayPgnToSteps(
  pgn: string,
  startPly: number,
):
  | { steps: PlyStep[]; headers: Record<string, string> }
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
  const steps: PlyStep[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const ply = i + 1;
    const fenBefore = replay.fen();
    const preventiveSolverSide = replay.turn() as 'w' | 'b';
    const playedUci = `${m.from}${m.to}${m.promotion ?? ''}`;
    try {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      return { error: `replay move failed at ply=${ply}` };
    }
    if (ply < startPly) continue;
    const fenAfter = replay.fen();
    const reactiveSolverSide = replay.turn() as 'w' | 'b';
    const isGameOverAfter = replay.isGameOver();
    steps.push({
      ply,
      fenBefore,
      fenAfter,
      playedUci,
      isGameOverAfter,
      reactiveSolverSide,
      preventiveSolverSide,
    });
  }
  return { steps, headers };
}

// ─── analyzePlyForBlunder ───────────────────────────────────────────

export type AnalyzePlyRejectReason =
  | 'samePv1'
  | 'gameOver'
  | 'noScore'
  | 'engineError'
  | 'notBlunder'
  | 'lowWplusDAfter';

export type AnalyzePlyResult =
  | { kind: 'accepted'; candidate: BlunderCandidate }
  | {
      kind: 'rejected';
      reason: AnalyzePlyRejectReason;
      deltaW?: number;
      deltaD?: number;
    };

/**
 * UCI-сравнение «первый ход PV совпадает со сыгранным» с учётом
 * опционального promotion-суффикса. Если совпадают — это не зевок,
 * движок сам так бы и сходил.
 */
export function samePv1(playedUci: string, pv1Uci: string): boolean {
  if (!playedUci || !pv1Uci) return false;
  return playedUci.length >= 4 && pv1Uci.length >= 4 && playedUci === pv1Uci;
}

/**
 * Анализ одного ply: pre + post через engine, затем evaluateBlunder.
 *
 * Стадии (соответствуют KS-2470 stage-based коду):
 *   1) pre-analyze fenBefore с multiPV=2 — получаем PV1 (правильный ход
 *      зевнувшего) + сам wdlBefore POV блaндера.
 *   2) samePv1 / gameOver pre-checks.
 *   3) post-analyze fenAfter с multiPV=2 — wdlAfter POV solver +
 *      firstMoveAfterUci (= PV1).
 *   4) evaluateBlunder → accept / reject (notBlunder | lowWplusDAfter).
 *
 * Внутри shared всё последовательно — параллелизм между ply внутри
 * партии достигается обёрткой через `Promise.all(steps.map(...))` или
 * через очередь engine-adapter'а. Это намеренно: shared не диктует
 * concurrency, она зависит от движка.
 */
export async function analyzePlyForBlunder(
  step: PlyStep,
  engine: PuzzleGenEngine,
  settings: BlunderEvalSettings,
): Promise<AnalyzePlyResult> {
  if (step.isGameOverAfter) {
    return { kind: 'rejected', reason: 'gameOver' };
  }
  let pre: SharedMultiPvLine[];
  try {
    pre = await engine.analyze(step.fenBefore, 2, {
      label: `ply=${step.ply} phase=analyze stage=pre`,
    });
  } catch {
    return { kind: 'rejected', reason: 'engineError' };
  }
  if (pre.length === 0 || !pre[0].bestMove) {
    return { kind: 'rejected', reason: 'engineError' };
  }
  if (samePv1(step.playedUci, pre[0].bestMove)) {
    return { kind: 'rejected', reason: 'samePv1' };
  }
  const wdlBeforeRaw = wdlOrMateFallback(pre[0].wdl, pre[0].score);
  if (wdlBeforeRaw == null) {
    return { kind: 'rejected', reason: 'noScore' };
  }

  let post: SharedMultiPvLine[];
  try {
    post = await engine.analyze(step.fenAfter, 2, {
      label: `ply=${step.ply} phase=analyze stage=post`,
    });
  } catch {
    return { kind: 'rejected', reason: 'engineError' };
  }
  if (post.length === 0 || !post[0].bestMove) {
    return { kind: 'rejected', reason: 'engineError' };
  }
  const wdlAfterRaw = wdlOrMateFallback(post[0].wdl, post[0].score);
  if (wdlAfterRaw == null) {
    return { kind: 'rejected', reason: 'noScore' };
  }

  const evalResult = evaluateBlunder(
    { wdlBeforeRaw, wdlAfterRaw },
    settings,
  );
  if (evalResult.kind === 'rejected') {
    return {
      kind: 'rejected',
      reason: evalResult.reason,
      deltaW: evalResult.deltaW,
      deltaD: evalResult.deltaD,
    };
  }
  return {
    kind: 'accepted',
    candidate: {
      step,
      wdlBeforeRaw,
      wdlAfterRaw,
      deltaW: evalResult.deltaW,
      deltaD: evalResult.deltaD,
      trigger: evalResult.trigger,
      pv1BeforeUci: pre[0].bestMove,
      firstMoveAfterUci: post[0].bestMove,
    },
  };
}

// ─── buildPuzzlesFromCandidate ─────────────────────────────────────

/**
 * ADR-070 §2.3 — на принятый зевок строит 1 или 2 пазла (реактивный +
 * превентивный). Стоимость одной партии в БД не растёт линейно — это
 * максимум 2× от текущего поведения, но кандидаты редки.
 *
 * Pre-filter для превентивного:
 *   `(wdlBeforeRaw.w + wdlBeforeRaw.d) / 1000 ≥ 0.5`. Иначе зевнувший
 *   до зевка уже проигрывает — нет смысла строить пазл «найди
 *   правильный ход чтобы не зевнуть, который тебя всё равно не спасает».
 *
 * Дедуп между двумя пазлами одного зевка не нужен: fenBefore ≠ fenAfter
 * после применения легального хода. Дедуп с уже сохранёнными — на БД
 * через `puzzles.fen UNIQUE` + `skipDuplicates`.
 */
export function buildPuzzlesFromCandidate(
  candidate: BlunderCandidate,
  gameMeta: GameMeta,
  settings: PuzzleGenSettings,
): GeneratedPuzzle[] {
  const out: GeneratedPuzzle[] = [];

  const commonMetaBase = {
    blunderMove: candidate.step.playedUci,
    fenBeforeBlunder: candidate.step.fenBefore,
    wdlBefore: candidate.wdlBeforeRaw,
    wdlAfter: candidate.wdlAfterRaw,
    // Legacy signed-варианты для backward-compat с старыми пазлами.
    wdlBeforeBlunder: round3(wdlSigned(candidate.wdlBeforeRaw)),
    wdlAfterBlunder: round3(wdlSigned(candidate.wdlAfterRaw)),
    deltaW: round3(candidate.deltaW),
    deltaD: round3(candidate.deltaD),
    blunderTrigger: candidate.trigger,
    halfMovesN: 6,
    winThreshold: settings.deltaWThreshold, // не путать с solvability win-thr
    failThreshold: 0.0,
    headers: gameMeta.headers,
  };

  if (settings.emitReactivePuzzle) {
    const objective = determinePuzzleObjective(candidate.wdlAfterRaw);
    const themes = ['playVsEngine', objective, 'reactive'];
    out.push({
      fen: candidate.step.fenAfter,
      sourceType: gameMeta.sourceType,
      sourceId: gameMeta.sourceId,
      sourceMoveNum: candidate.step.ply,
      themes,
      rating: 1500, // обёртка обычно пересчитывает через computeStartingRating
      solutionMode: 'play-vs-engine',
      puzzlePhase: 'reactive',
      objective,
      solverSide: candidate.step.reactiveSolverSide,
      sourceMetadata: {
        ...commonMetaBase,
        objective,
        puzzlePhase: 'reactive',
        firstMovePV1: candidate.firstMoveAfterUci,
      },
    });
  }

  if (settings.emitPreventivePuzzle) {
    const wBeforePm =
      (candidate.wdlBeforeRaw.w + candidate.wdlBeforeRaw.d) / 1000;
    if (wBeforePm >= 0.5) {
      const objectiveP: PuzzleObjective =
        candidate.wdlBeforeRaw.w / 1000 >= 0.5
          ? 'convertAdvantage'
          : 'saveEquality';
      const themes = ['playVsEngine', objectiveP, 'preventive'];
      out.push({
        fen: candidate.step.fenBefore,
        sourceType: gameMeta.sourceType,
        sourceId: gameMeta.sourceId,
        sourceMoveNum: candidate.step.ply,
        themes,
        rating: 1500,
        solutionMode: 'play-vs-engine',
        puzzlePhase: 'preventive',
        objective: objectiveP,
        solverSide: candidate.step.preventiveSolverSide,
        sourceMetadata: {
          ...commonMetaBase,
          objective: objectiveP,
          puzzlePhase: 'preventive',
          // KS-4100 / ADR-124 §2.4. ИНВАРИАНТ: каждый PVE-пазл обязан
          // иметь `firstMovePV1` — правильный первый ход solver'а. Для
          // preventive это PV1 движка на fenBefore (то, что должен был
          // сыграть «зевнувший»). Раньше поле НЕ ставилось → Maia-
          // аннотация падала `no-solution-uci` (корень KS-4096, 2/13
          // пазлов с maiaWeakChoiceProb=null). Чинится один раз в общем
          // pipeline — исправляет и клиент, и сервер.
          firstMovePV1: candidate.pv1BeforeUci,
          // Правильный ход (PV1 движка на fenBefore) — то, что должен
          // был сыграть «зевнувший». UI может подсветить как hint.
          // Дубликат firstMovePV1 — оставлен для обратной совместимости.
          preventiveCorrectMoveUci: candidate.pv1BeforeUci,
        },
      });
    }
  }

  return out;
}

// ─── processGameForPuzzles (high-level) ────────────────────────────

export interface ProcessGameArgs {
  pgn: string;
  gameMeta: GameMeta;
  engine: PuzzleGenEngine;
  settings: PuzzleGenSettings;
  onProgress?: (s: { ply: number; total: number }) => void;
  abortSignal?: AbortSignal;
}

export interface ProcessGameResult {
  puzzles: GeneratedPuzzle[];
  stats: {
    positionsAnalyzed: number;
    drops: Record<AnalyzePlyRejectReason, number>;
  };
}

/**
 * Главный entry-point обёртки. Делает replay PGN → analyzePlyForBlunder
 * для каждого step → buildPuzzlesFromCandidate. Не делает БД-insert,
 * не управляет concurrency между партиями (это работа обёртки).
 *
 * Concurrency внутри партии: shared последовательно проходит ply.
 * Server-обёртка может вызывать processGameForPuzzles параллельно
 * для разных партий через GAME_CONCURRENCY; внутри одной партии
 * последовательная обработка — нормально, потому что Stockfish-пул
 * сам ограничен по STOCKFISH_POOL_SIZE и параллельные ply делили бы
 * один пул.
 */
export async function processGameForPuzzles(
  args: ProcessGameArgs,
): Promise<ProcessGameResult> {
  const replay = replayPgnToSteps(args.pgn, args.settings.startPly);
  if ('error' in replay) {
    return {
      puzzles: [],
      stats: {
        positionsAnalyzed: 0,
        drops: emptyDrops(),
      },
    };
  }
  const stats: ProcessGameResult['stats'] = {
    positionsAnalyzed: 0,
    drops: emptyDrops(),
  };
  const puzzles: GeneratedPuzzle[] = [];
  for (let i = 0; i < replay.steps.length; i++) {
    if (args.abortSignal?.aborted) break;
    const step = replay.steps[i];
    stats.positionsAnalyzed++;
    const r = await analyzePlyForBlunder(step, args.engine, args.settings);
    if (r.kind === 'rejected') {
      stats.drops[r.reason]++;
      args.onProgress?.({ ply: i + 1, total: replay.steps.length });
      continue;
    }
    const built = buildPuzzlesFromCandidate(
      r.candidate,
      args.gameMeta,
      args.settings,
    );
    puzzles.push(...built);
    args.onProgress?.({ ply: i + 1, total: replay.steps.length });
  }
  return { puzzles, stats };
}

// ─── helpers ────────────────────────────────────────────────────────

function emptyDrops(): Record<AnalyzePlyRejectReason, number> {
  return {
    samePv1: 0,
    gameOver: 0,
    noScore: 0,
    engineError: 0,
    notBlunder: 0,
    lowWplusDAfter: 0,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
