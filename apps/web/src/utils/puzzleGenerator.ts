import {
  PUZZLE_GEN_DEFAULTS,
  analyzePlyForBlunder,
  buildPuzzlesFromCandidate,
  replayPgnToSteps,
  wdlSigned,
  wdlSignedFromInfo,
  wdlOrMateFallback,
  type AnalyzePlyRejectReason,
  type GameMeta,
  type GeneratedPuzzle as SharedGeneratedPuzzle,
  type PuzzleGenEngine,
  type PuzzleGenSettings as SharedPipelineSettings,
  type PuzzleObjective,
  type PuzzlePhase,
  type SharedMultiPvLine,
  type Wdl,
} from '@kingside/shared';
import type { EngineAdapter, BridgeConfig, InfoLine } from './engineAdapter';
import { WasmEngineAdapter, BridgeEngineAdapter } from './engineAdapter';

export type { BridgeConfig };

/**
 * KS-3160 / ADR-070 F1 — клиентский генератор пазлов как тонкая обёртка
 * над shared `processGameForPuzzles`. До этой задачи фронт держал
 * собственную копию stage-based pipeline'а (replay PGN → pre/post
 * analyze → evaluateBlunder → push), которая расходилась с серверной
 * в деталях форматирования `sourceMetadata` и в наборе тегов.
 *
 * После ADR-070 §2.1 — единственный pipeline в `@kingside/shared`,
 * обёртка только адаптирует I/O:
 *  - `ClientPuzzleGenEngine` оборачивает `EngineAdapter` (WASM/Bridge)
 *    в shared-`PuzzleGenEngine` (`SharedMultiPvLine[]`).
 *  - `generatePuzzlesFromPgn` итерирует по партиям, формирует
 *    `GameMeta` из PGN-headers и пробрасывает в `processGameForPuzzles`.
 *  - Конвертирует `SharedGeneratedPuzzle[]` → `GeneratedPuzzleData[]`,
 *    сохраняя совместимость с UI (`PuzzleGeneratorModal`) и
 *    backend-save `BatchPuzzleItem`. Плоские поля
 *    `white`/`black`/`event`/`date`/`result` восстанавливаются из
 *    `headers`, добавляется `depth` для аудита.
 *
 * Client settings:
 *  - `minPlayerElo = 0` — пользователь генерит из своих партий, фильтра нет.
 *  - `emitPreventivePuzzle = true` / `emitReactivePuzzle = true` —
 *    обе фазы из ADR-070 §2.3 (превентивный «не упусти позицию» +
 *    реактивный «накажи зевок»). На один кандидат-зевок получается до
 *    двух пазлов: превентивный pre-filter `(W+D)_before ≥ 0.5` отсеет
 *    случаи, где зевнувший до зевка уже проигрывал.
 *  - `startPly` — из `PUZZLE_GEN_DEFAULTS.startPly` (20).
 *
 * `solvabilityCheck` (был toggle в advanced-настройках модалки до KS-3160)
 * удалён вместе с локальным `solvabilityPasses`. В shared pipeline такого
 * этапа нет — серверный tactic-worker тоже его не использует после
 * KS-3157. Решаемость гарантирует after-фильтр `evaluateBlunder`
 * (`W+D ≥ minWPlusDAfterForSolver`).
 */

// ─── Engine adapter ────────────────────────────────────────────────

/**
 * KS-3160: переводит `InfoLine` (WASM/Bridge adapter) в общий формат
 * shared `SharedMultiPvLine`. Pipeline'у важны три поля: `bestMove`
 * (UCI первого хода PV), `score` (для mate-fallback) и опционально
 * `wdl` (полное распределение per-mille).
 */
function toSharedLine(line: InfoLine): SharedMultiPvLine {
  return {
    bestMove: line.pv[0] ?? '',
    score: line.score,
    wdl: line.wdl ?? null,
  };
}

class ClientPuzzleGenEngine implements PuzzleGenEngine {
  constructor(
    private readonly engine: EngineAdapter,
    private readonly depth: number,
    private readonly movetimeMs: number,
    /**
     * KS-3364: лимит по числу позиций анализа на каждый ply
     * (`go nodes N`). По умолчанию 10M — баланс между качеством оценки
     * WDL и временем (1–4 сек на ply на современном CPU в Chrome).
     * `0`/`undefined` → не передаём nodes, ограничение только по depth.
     */
    private readonly nodes: number | undefined,
  ) {}

  async analyze(
    fen: string,
    multiPV: number,
    ctx?: { label?: string; signal?: AbortSignal },
  ): Promise<SharedMultiPvLine[]> {
    void ctx; // label для UCI-логов сервера, на клиенте не нужен
    const result = await this.engine.analyze(
      fen,
      this.depth,
      multiPV,
      this.movetimeMs,
      this.nodes,
    );
    return result.lines.map(toSharedLine);
  }
}

// ─── Public types (UI/save-payload contract) ──────────────────────

export type SourceMetadata = {
  white?: string;
  black?: string;
  event?: string;
  date?: string;
  result?: string;
  blunderMove?: string;
  fenBeforeBlunder?: string;
  wdlBefore?: Wdl;
  wdlAfter?: Wdl;
  /** `wdlSigned` POV блaндера на fenBefore (legacy для UX). */
  wdlBeforeBlunder?: number;
  /** `wdlSigned` POV решающего на fenAfter (legacy для UX). */
  wdlAfterBlunder?: number;
  deltaW?: number;
  deltaD?: number;
  blunderTrigger?: string;
  halfMovesN?: number;
  winThreshold?: number;
  failThreshold?: number;
  depth?: number;
  /**
   * KS-3146 (ADR-069) / KS-3160 (ADR-070): жанр пазла и фаза.
   * Backend читает плоский `sourceMetadata.objective` (KS-3149) и
   * `sourceMetadata.puzzlePhase`.
   */
  objective?: PuzzleObjective;
  puzzlePhase?: PuzzlePhase;
  firstMovePV1?: string;
  preventiveCorrectMoveUci?: string;
};

export type GeneratedPuzzleData = {
  fen: string;
  /**
   * KS-2584: для play-vs-engine пазлов solution-линия не известна
   * заранее (соперник = Stockfish), runtime определяет ход.
   */
  moves: string;
  /** @deprecated KS-2584. */
  acceptedMoves?: string;
  rating: number;
  themes: string;
  sourceType: string;
  sourceId: string | null;
  sourceMoveNum: number;
  sourceMetadata?: SourceMetadata;
  solutionMode: 'play-vs-engine';
  isPublic: false;
  /** KS-3160: фаза для UI (бейдж/сортировка/фильтр). */
  puzzlePhase?: PuzzlePhase;
  /** KS-3160: жанр (дублирует sourceMetadata.objective для удобства). */
  objective?: PuzzleObjective;
  /** KS-3160: сторона solver'а на стартовом FEN. */
  solverSide?: 'w' | 'b';
  /**
   * KS-4096: Maia weak-choice метрика, посчитанная на клиенте (Maia-policy
   * + Stockfish MultiPV WDL → computeWeakChoiceProb). До этой задачи
   * клиентский генератор шаг Maia пропускал, и все client-generated
   * PVE-пазлы сохранялись с `maiaWeakChoiceProb=null` → расхождение с
   * серверной генерацией, `/precision/next?minMaiaWeakChoiceProb=…` их не
   * отдавал. Заполняется в `annotatePuzzlesWithMaia` перед POST
   * /puzzles/batch. `undefined`, если аннотация не запускалась / упала —
   * тогда поведение как раньше (backend оставит null).
   */
  maiaWeakChoiceProb?: number;
  /** KS-4096: версия алгоритма метрики (MAIA_WEAK_CHOICE_METRIC_VERSION). */
  maiaMetricVersion?: number;
  /** KS-4096: ELO разметки Maia (audit-поле, серверный дефолт 1500). */
  maiaTop1Elo?: number;
};

export type GenerationProgress = {
  gameIndex: number;
  totalGames: number;
  positionIndex: number;
  totalPositions: number;
  puzzlesFound: number;
  /**
   * KS-4096: фаза прогресса. `analyzing` — основной проход SF по позициям
   * (по умолчанию, обратная совместимость с UI). `maia` — пост-проход
   * Maia weak-choice разметки найденных пазлов. UI может игнорировать
   * поле; для фазы `maia` `positionIndex/totalPositions` отражают
   * прогресс разметки.
   */
  phase?: 'analyzing' | 'maia';
};

/**
 * Client-facing настройки. UI (`PuzzleGeneratorModal`) даёт юзеру
 * управлять `depth`, `movetimeMs`, `deltaWThreshold`, `deltaDThreshold`.
 * `minWPlusDAfterForSolver` под UI не вынесен — defensive фильтр.
 *
 * Эти настройки внутри `generatePuzzlesFromPgn` собираются в полные
 * `SharedPipelineSettings` (`minPlayerElo=0`, emit* = true, startPly из
 * shared-дефолтов).
 */
export interface PuzzleGenSettings {
  /**
   * Глубина SF-анализа (полуходов). Внутренний safety-cap, чтобы SF на
   * лёгких позициях не залипал на бесконечности при крупном nodes-
   * budget'е. UI юзер не настраивает (KS-3364) — управляет nodes.
   */
  depth: number;
  /**
   * KS-2955: нижний порог времени на каждый analyze (мс). UI юзер
   * не настраивает (KS-3364) — управляет nodes. Сохраняется для
   * других потребителей (PlayVsEngineRunner) с поведением по умолчанию.
   */
  movetimeMs: number;
  /**
   * KS-3364: лимит по числу позиций SF на каждый ply (`go nodes N`).
   * Заменяет UI-слайдер «Глубина». Default 10 000 000 (10M) — баланс
   * между качеством WDL и временем (≈1–4с на ply в Chrome на M1).
   * Если 0/undefined — лимит только по depth/movetime.
   */
  nodes: number;
  /** KS-3137 (ADR-068): порог по падению P(победы) блaндера. Default 0.6. */
  deltaWThreshold: number;
  /** KS-3137 (ADR-068): порог по падению P(ничьи) блaндера. Default 0.6. */
  deltaDThreshold: number;
  /**
   * KS-3140 (ADR-068 §3.2 rev2): единый after-фильтр W+D ≥ X.
   * Default 0.5. Без UI (defensive).
   */
  minWPlusDAfterForSolver: number;
}

/**
 * KS-3364: дефолт по узлам — 10 миллионов. На современном CPU в Chrome
 * это даёт depth≈18 за 1–4 секунды на ply, что близко к параметру
 * `AnalysisLimit.nodes` серверной генерации (5M в tactic-worker).
 */
export const PUZZLE_GEN_DEFAULT_NODES = 10_000_000;
/** KS-3364: границы UI-слайдера «Узлы» (миллионы). */
export const PUZZLE_GEN_NODES_MIN = 1_000_000;
export const PUZZLE_GEN_NODES_MAX = 40_000_000;
export const PUZZLE_GEN_NODES_STEP = 1_000_000;

export const DEFAULT_PUZZLE_GEN_SETTINGS: PuzzleGenSettings = {
  // KS-3364: depth — внутренний safety-cap (22 покрывает любой
  // реалистичный nodes-budget); пользователь его не двигает.
  depth: 22,
  movetimeMs: 1000,
  nodes: PUZZLE_GEN_DEFAULT_NODES,
  deltaWThreshold: PUZZLE_GEN_DEFAULTS.deltaWThreshold,
  deltaDThreshold: PUZZLE_GEN_DEFAULTS.deltaDThreshold,
  minWPlusDAfterForSolver: PUZZLE_GEN_DEFAULTS.minWPlusDAfterForSolver,
};

const MULTI_PV = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * KS-2584: упрощённый `computeStartingRating`. MVP: 1500 базовый, −150
 * если позиция сильно разгромная (легче решить, нужно ниже). После
 * KS-3160 используется только для реактивного пазла — у превентивного
 * solver «удерживает» позицию, и base 1500 без понижения.
 */
function computeStartingRating(wdlAfterForSolverSigned: number): number {
  const base = 1500 - (wdlAfterForSolverSigned > 0.85 ? 150 : 0);
  return clamp(base, 800, 2000);
}

function parseEloOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── generatePuzzlesFromPgn (обёртка) ──────────────────────────────

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
  const { depth, movetimeMs, nodes } = settings;
  const { abortSignal, bridgeConfig, engineFactory } = options;

  const games = splitPgnIntoGames(pgn);
  console.log(
    '[PuzzleGen] PGN split into',
    games.length,
    'games, input length:',
    pgn.length,
  );

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

  const sharedEngine = new ClientPuzzleGenEngine(
    engine,
    depth,
    movetimeMs,
    nodes && nodes > 0 ? nodes : undefined,
  );
  const sharedSettings: SharedPipelineSettings = {
    deltaWThreshold: settings.deltaWThreshold,
    deltaDThreshold: settings.deltaDThreshold,
    minWPlusDAfterForSolver: settings.minWPlusDAfterForSolver,
    // KS-3160 client policy: пользователь генерит из своих партий,
    // фильтра по Elo нет.
    minPlayerElo: 0,
    startPly: PUZZLE_GEN_DEFAULTS.startPly,
    // ADR-070 §2.3: обе фазы.
    emitPreventivePuzzle: true,
    emitReactivePuzzle: true,
  };

  const all: GeneratedPuzzleData[] = [];
  const totalDrops: Partial<Record<AnalyzePlyRejectReason, number>> = {};

  // KS-3163: переход с `processGameForPuzzles` (high-level) на
  // low-level shared API (`replayPgnToSteps` + `analyzePlyForBlunder` +
  // `buildPuzzlesFromCandidate`). High-level версия не сообщала
  // обёртке текущий puzzle count во время прогона — UI-счётчик
  // «Найдено задач: N» был всегда 0 пока партия анализировалась и
  // обновлялся только в финале. Тут обёртка сама итерирует по ply,
  // видит каждый accept и инкрементит `all` ДО следующего вызова
  // `onProgress`. Получаем real-time счётчик без правки shared.
  for (let gi = 0; gi < games.length; gi++) {
    if (abortSignal?.aborted) break;
    const gamePgn = stripPgnAnnotations(games[gi]);

    const headers = parsePgnHeaders(gamePgn);
    const gameMeta: GameMeta = {
      sourceType: 'pgn_import',
      sourceId: null,
      whiteElo: parseEloOrNull(headers.WhiteElo),
      blackElo: parseEloOrNull(headers.BlackElo),
      headers,
    };

    const replay = replayPgnToSteps(gamePgn, sharedSettings.startPly);
    if ('error' in replay) {
      console.warn(
        '[PuzzleGen] Game',
        gi + 1,
        'replay failed:',
        replay.error,
      );
      continue;
    }
    const totalPositions = replay.steps.length;
    for (let pi = 0; pi < totalPositions; pi++) {
      if (abortSignal?.aborted) break;
      const step = replay.steps[pi];
      const result = await analyzePlyForBlunder(
        step,
        sharedEngine,
        sharedSettings,
      );
      if (result.kind === 'rejected') {
        totalDrops[result.reason] = (totalDrops[result.reason] ?? 0) + 1;
      } else {
        const built = buildPuzzlesFromCandidate(
          result.candidate,
          gameMeta,
          sharedSettings,
        );
        for (const sp of built) {
          all.push(adaptSharedPuzzle(sp, headers, depth));
        }
      }
      // KS-3163: incremental прогресс — счётчик `puzzlesFound` теперь
      // отражает реальное число накопленных пазлов на момент текущего
      // ply, а не только пост-партийный итог.
      onProgress({
        gameIndex: gi,
        totalGames: games.length,
        positionIndex: pi + 1,
        totalPositions,
        puzzlesFound: all.length,
      });
    }
  }

  // KS-4096: пост-проход Maia weak-choice (annotatePuzzlesWithMaia)
  // ВРЕМЕННО ОТКЛЮЧЁН. Диагностика devops (build e5f344f): браузерный
  // entry maia-core по-прежнему НЕ экспортирует buildMaiaSearchMoves —
  // фикс backend 4d54005f не подействовал (проверяется его наличие в
  // истории main и правка именно src/browser.ts). Ждём рабочего фикса
  // экспортов браузерного entry. Код шага готов в maiaWeakChoice.ts
  // (не подключён) — подключение = вернуть импорт + этот блок.

  engine.destroy();
  // KS-3153: сводка дроп-причин в финальном логе для DevTools.
  console.log(
    '[PuzzleGen] Done. Total puzzles:',
    all.length,
    '| Drops by reason:',
    totalDrops,
  );
  return all;
}

/**
 * KS-3160: SharedGeneratedPuzzle → GeneratedPuzzleData. Сохраняет
 * совместимость с UI и backend save-route.
 * - `themes`: массив → строка (joinим пробелом, оставляем порядок shared).
 * - `sourceMetadata`: плоский Record с PGN-headers, развёрнутыми из
 *   shared `headers`-блока, плюс `depth` (важно для аудита, в shared
 *   нет — pipeline сам по себе не знает про engine-depth обёртки).
 * - `rating`: пересчёт через `computeStartingRating` для реактивного;
 *   у превентивного оставляем базовое 1500 (solver удерживает, разгром
 *   тут не показатель «лёгкости»).
 */
function adaptSharedPuzzle(
  sp: SharedGeneratedPuzzle,
  headers: Record<string, string>,
  depth: number,
): GeneratedPuzzleData {
  const sm = { ...(sp.sourceMetadata as Record<string, unknown>) };
  // headers-блок shared сжат в Record<string,string>. Раньше фронт
  // писал плоские поля white/black/event/date/result — backend save-
  // route их читает. Сохраняем обратную совместимость.
  delete sm.headers;
  const flat: SourceMetadata = {
    ...(sm as SourceMetadata),
    white: headers.White,
    black: headers.Black,
    event: headers.Event,
    date: headers.Date,
    result: headers.Result,
    depth,
  };

  // KS-4096: гарантируем `firstMovePV1` у каждого пазла. Серверный
  // shared-пайплайн (`buildPuzzlesFromCandidate`) задаёт его ТОЛЬКО для
  // реактивного пазла (candidate.firstMoveAfterUci); у превентивного в
  // sourceMetadata лежит `preventiveCorrectMoveUci` (PV1 движка на
  // fenBefore — правильный ход «зевнувшего»), но не `firstMovePV1`.
  // Без него Maia-аннотация падает на `no-solution-uci` (это и были
  // «2 из 13» пазлов без метрики). Для превентивного пазла стартовый
  // FEN = fenBefore, и его решение = preventiveCorrectMoveUci, поэтому
  // оно и есть firstMovePV1.
  if (!flat.firstMovePV1 && flat.preventiveCorrectMoveUci) {
    flat.firstMovePV1 = flat.preventiveCorrectMoveUci;
  }

  let rating = sp.rating;
  if (sp.puzzlePhase === 'reactive') {
    const wdlAfter = sp.sourceMetadata.wdlAfter as Wdl | undefined;
    if (wdlAfter) rating = computeStartingRating(wdlSigned(wdlAfter));
  }

  return {
    fen: sp.fen,
    moves: '',
    rating,
    themes: sp.themes.join(' '),
    sourceType: sp.sourceType,
    sourceId: sp.sourceId,
    sourceMoveNum: sp.sourceMoveNum,
    sourceMetadata: flat,
    solutionMode: 'play-vs-engine',
    isPublic: false,
    puzzlePhase: sp.puzzlePhase,
    objective: sp.objective,
    solverSide: sp.solverSide,
  };
}

// ─── PGN-парсер ─────────────────────────────────────────────────────

function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) headers[m[1]] = m[2];
  return headers;
}

/**
 * KS-2683: убрать комментарии `{…}`, варианты `(…)` (с поддержкой
 * вложенности), NAG-аннотации `$N`, лишние пробелы из movetext.
 * Header tags пропускаем — там скобки не имеют отдельного смысла.
 */
function stripPgnAnnotations(pgn: string): string {
  const lines = pgn.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('[')) {
      result.push(line);
      continue;
    }
    let cleaned = '';
    let inComment = false;
    let parenDepth = 0;
    for (const ch of line) {
      if (inComment) {
        if (ch === '}') inComment = false;
        continue;
      }
      if (ch === '{') {
        inComment = true;
        continue;
      }
      if (ch === '(') {
        parenDepth++;
        continue;
      }
      if (ch === ')') {
        if (parenDepth > 0) parenDepth--;
        continue;
      }
      if (parenDepth > 0) continue;
      cleaned += ch;
    }
    cleaned = cleaned
      .replace(/\$\d+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    result.push(cleaned);
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

export { wdlSigned, wdlSignedFromInfo, wdlOrMateFallback };
export type { Wdl };
