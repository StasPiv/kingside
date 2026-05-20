import { Chess } from 'chess.js';
import {
  PUZZLE_GEN_DEFAULTS,
  evaluateBlunder,
  wdlOrMateFallback,
  wdlSigned,
  wdlSignedFromInfo,
  type BlunderEvalSettings,
  type BlunderTrigger,
  type Wdl,
} from '@kingside/shared';
import type { EngineAdapter, BridgeConfig, InfoLine } from './engineAdapter';
import { WasmEngineAdapter, BridgeEngineAdapter } from './engineAdapter';

export type { BridgeConfig };

/**
 * KS-2584 / KS-3137 / KS-3140 (ADR-068 §3.4 rev2) — клиентский генератор
 * пазлов на WDL-алгоритме. Зеркало серверного
 * `tactic-worker/puzzle-generator`: обе обёртки вызывают **одну и ту же**
 * `evaluateBlunder` из `@kingside/shared`, отличие только в настройках.
 *
 * KS-3140: pre-condition `skipDecided` (|wdlBefore_signed| > 0.95) убран
 * — он отсекал целый жанр пазлов «реализуй перевес» (см. KS-3139
 * диагностика). Чтобы упустить позицию, надо сначала её иметь; если
 * белые в выигрышной позиции зевнули в ничью или проигрыш — это и есть
 * хороший пазл. После KS-3140 такие позиции проходят через
 * `evaluateBlunder` и фильтруются единым after-фильтром
 * `W+D ≥ minWPlusDAfterForSolver`.
 *
 * Псевдокод:
 *
 *   для каждой позиции (ply ≥ startPly):
 *     fenBefore, playedUci = ход партии
 *     [line1, …] = analyze(fenBefore, depth, multiPV=2)
 *     if line1.pv[0] === playedUci          → drop:samePv1
 *     fenAfter = apply(playedUci)
 *     if isGameOver(fenAfter)               → drop:gameOver
 *     [a1, …] = analyze(fenAfter, depth, multiPV=2)
 *     wdlBeforeRaw = wdlOrMateFallback(line1.wdl, line1.score)  // POV блaндера
 *     wdlAfterRaw  = wdlOrMateFallback(a1.wdl, a1.score)        // POV решателя
 *     result = evaluateBlunder({wdlBeforeRaw, wdlAfterRaw}, settings)
 *     if result.kind === 'rejected'         → drop:<result.reason>
 *     (опц.) solvability check (halfMovesN полу-ходов SF-vs-SF)
 *     accept → play-vs-engine puzzle, isPublic=false
 *
 * Дефолты порогов — `PUZZLE_GEN_DEFAULTS` (`deltaWThreshold`,
 * `deltaDThreshold`, `minWPlusDAfterForSolver`), единый источник для
 * server+client (см. ADR-068 §6).
 *
 * Если у engine info нет `wdl` и score не mate — `wdlOrMateFallback`
 * вернёт `null`, позиция skip:noWdl (старые сборки Stockfish без
 * `UCI_ShowWDL` или bridge без поддержки опции — см. KS-2690).
 */

export type SourceMetadata = {
  white?: string;
  black?: string;
  event?: string;
  date?: string;
  result?: string;
  // KS-2584: WDL-метаданные пазла (зеркало серверного DTO `playVsEngine`).
  blunderMove?: string;
  /** `wdlSigned` POV блaндера на fenBefore (для UX «насколько была выгода»). */
  wdlBeforeBlunder?: number;
  /** `wdlSigned` POV решающего на fenAfter (для UX «насколько перевес после зевка»). */
  wdlAfterBlunder?: number;
  /**
   * KS-3137: дельты из `evaluateBlunder`. `deltaW` — падение P(победы)
   * блaндера за ход; `deltaD` — падение P(ничьи). `blunderTrigger` —
   * какая дельта пробила порог ('W' | 'D' | 'WD').
   */
  deltaW?: number;
  deltaD?: number;
  blunderTrigger?: BlunderTrigger;
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
  /**
   * Глубина SF-анализа (полуходов). По умолчанию 18 — выровнено с
   * `PlayVsEngineRunner` (KS-2955), чтобы оценка `wdlAfterBlunder` при
   * генерации совпадала с оценкой при последующей игре пазла. На меньших
   * глубинах SF18 WASM в насыщенных позициях даёт ложные WDL.
   */
  depth: number;
  /**
   * KS-2955: нижний порог времени на каждый analyze (мс). Парой с `depth`
   * гарантирует ≥1 секунды на оценку каждой позиции — те же параметры,
   * что в раннере, чтобы gen-time и run-time не расходились.
   */
  movetimeMs: number;
  /**
   * KS-3137 (ADR-068 §1.2): порог по падению вероятности победы блaндера
   * за ход (`deltaW`). Используется как один из двух OR-триггеров в
   * `evaluateBlunder`. Default `PUZZLE_GEN_DEFAULTS.deltaWThreshold` = 0.6.
   */
  deltaWThreshold: number;
  /**
   * KS-3137 (ADR-068 §1.2): порог по падению вероятности ничьи блaндера
   * за ход (`deltaD`). Второй OR-триггер. Default 0.6.
   */
  deltaDThreshold: number;
  /**
   * KS-3137 / KS-3140 (ADR-068 §3.2 rev2): единый after-фильтр —
   * минимальная сумма `W + D` решающего сразу после хода блaндера.
   * Покрывает «реализуй перевес» (W_after велик) и «спасение в ничью»
   * (D_after велик при W_after≈0). Раньше был раздельный
   * `minWAfterForSolver` (только W) — KS-3140 объединил, потому что
   * прежний фильтр терял класс «триггер по W + solver получает ничью».
   * Под UI не вынесен (defensive), берём из `PUZZLE_GEN_DEFAULTS`.
   */
  minWPlusDAfterForSolver: number;
  /**
   * Включить halfMovesN=6 SF-vs-SF проверку решаемости пазла. На
   * MVP по умолчанию выключено (тяжёлый отдельный анализ × N полуходов).
   */
  solvabilityCheck: boolean;
}

export const DEFAULT_PUZZLE_GEN_SETTINGS: PuzzleGenSettings = {
  depth: 18,
  movetimeMs: 1000,
  deltaWThreshold: PUZZLE_GEN_DEFAULTS.deltaWThreshold,
  deltaDThreshold: PUZZLE_GEN_DEFAULTS.deltaDThreshold,
  minWPlusDAfterForSolver: PUZZLE_GEN_DEFAULTS.minWPlusDAfterForSolver,
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
  movetimeMs: number,
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
    const result = await engine.analyze(chess.fen(), depth, 1, movetimeMs);
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

/**
 * KS-3137: извлечь сырой `Wdl` (POV side-to-move) из info-строки. На
 * mate-сценарии возвращает `{w:1000,d:0,l:0}` / `{w:0,d:0,l:1000}`,
 * на cp без WDL — `null` (caller обязан skip:noWdl).
 */
function extractWdlRaw(line: InfoLine): Wdl | null {
  return wdlOrMateFallback(line.wdl ?? null, line.score);
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
  const { depth, movetimeMs, solvabilityCheck } = settings;
  const { abortSignal, bridgeConfig, engineFactory } = options;
  const startPly = PUZZLE_GEN_DEFAULTS.startPly;
  // KS-3137 / KS-3140: настройки порогов передаём прямо в `evaluateBlunder`.
  // Поле `minWAfterForSolver` (KS-3136) убрано в KS-3140 — заменено единым
  // after-фильтром W+D ≥ minWPlusDAfterForSolver.
  const blunderSettings: BlunderEvalSettings = {
    deltaWThreshold: settings.deltaWThreshold,
    deltaDThreshold: settings.deltaDThreshold,
    minWPlusDAfterForSolver: settings.minWPlusDAfterForSolver,
  };

  const games = splitPgnIntoGames(pgn);
  console.log(
    '[PuzzleGen] PGN split into',
    games.length,
    'games, input length:',
    pgn.length,
  );
  const puzzles: GeneratedPuzzleData[] = [];
  // KS-2690: single-shot warn для DevTools, чтобы пользователь увидел
  // причину «0 пазлов», если bridge стоит за движком без UCI_ShowWDL
  // (старый Stockfish, другой движок). После первой записи о noWdl за
  // прогон больше не повторяем — лог не спамится.
  let wdlMissingWarned = false;
  const warnNoWdlOnce = () => {
    if (wdlMissingWarned) return;
    wdlMissingWarned = true;
    console.warn(
      '[PuzzleGen] info-строка от движка не содержит wdl ' +
        '(UCI_ShowWDL=true). На WASM это включается автоматически; ' +
        'для Bridge — после connect (KS-2690). Если предупреждение ' +
        'остаётся — движок за bridge не поддерживает UCI_ShowWDL и ' +
        'все позиции будут пропущены. Замените движок на современный ' +
        'Stockfish (≥15) или включите опцию вручную.',
    );
  };

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
        beforeRes = await engine.analyze(fenBefore, depth, MULTI_PV, movetimeMs);
      } catch (e) {
        console.error(`${logBase} SKIP:analyzeBeforeError`, e);
        continue;
      }
      if (beforeRes.lines.length === 0) {
        console.log(`${logBase} SKIP:noLinesBefore`);
        continue;
      }
      const lineBefore = beforeRes.lines[0];
      const wdlBeforeRaw = extractWdlRaw(lineBefore);
      if (wdlBeforeRaw === null) {
        // KS-2690: explicit warn про UCI_ShowWDL — single-shot per
        // session, чтобы пользователь увидел в DevTools реальную
        // причину 0 пазлов на bridge без поддержки опции.
        if (lineBefore.wdl === undefined) warnNoWdlOnce();
        console.log(`${logBase} SKIP:noWdlBefore`);
        continue;
      }
      const wdlBeforeSigned = wdlSigned(wdlBeforeRaw);
      if (lineBefore.pv[0] === playedUci) {
        console.log(
          `${logBase} wdlBefore=${round3(wdlBeforeSigned)} SKIP:samePv1`,
        );
        continue;
      }
      // KS-3140: pre-condition `skipDecided` (|wdlBefore_signed|>0.95)
      // снят — он отрезал жанр «реализуй перевес». Теперь любые
      // позиции (включая «белые уже выигрывают») идут в evaluateBlunder
      // и проходят/отбраковываются единым after-фильтром по W+D.

      // Анализ after. Side-to-move на fenAfter = РЕШАТЕЛЬ (соперник
      // сходившего). Stockfish отдаёт `Wdl` POV side-to-move, то есть
      // `wdlAfterRaw` — POV решающего.
      let afterRes;
      try {
        afterRes = await engine.analyze(fenAfter, depth, MULTI_PV, movetimeMs);
      } catch (e) {
        console.error(`${logBase} SKIP:analyzeAfterError`, e);
        continue;
      }
      if (afterRes.lines.length === 0) {
        console.log(`${logBase} SKIP:noLinesAfter`);
        continue;
      }
      const lineAfter = afterRes.lines[0];
      const wdlAfterRaw = extractWdlRaw(lineAfter);
      if (wdlAfterRaw === null) {
        if (lineAfter.wdl === undefined) warnNoWdlOnce();
        console.log(`${logBase} SKIP:noWdlAfter`);
        continue;
      }
      const wdlAfterSignedForSolver = wdlSigned(wdlAfterRaw);

      // KS-3137 / ADR-068 §3.4: единая (server+client) оценка зевка.
      // Здесь больше не считаем дельты руками — `evaluateBlunder`
      // возвращает либо `{kind:'blunder', trigger, deltaW, deltaD}`,
      // либо `{kind:'rejected', reason, deltaW, deltaD}` с теми же
      // дельтами для drop-логов.
      const result = evaluateBlunder(
        { wdlBeforeRaw, wdlAfterRaw },
        blunderSettings,
      );
      if (result.kind === 'rejected') {
        console.log(
          `${logBase} wdlBefore=${round3(wdlBeforeSigned)} wdlAfter=${round3(wdlAfterSignedForSolver)} deltaW=${round3(result.deltaW)} deltaD=${round3(result.deltaD)} SKIP:${result.reason}`,
        );
        continue;
      }

      // Mate check (для тагов).
      if (lineAfter.score.type === 'mate') {
        // KS-2677: mate value на fenAfter — POV side-to-move = POV
        // РЕШАТЕЛЯ. Положительное значение = mate в пользу решателя
        // (нам нужен этот случай для мат-пазла). Раньше тут проверялось
        // `< 0` под ошибочным предположением, что score POV блaндера —
        // в результате `mateInN` ставился НЕ для тех пазлов.
        if (lineAfter.score.value > 0) {
          isMate = true;
          mateDist = lineAfter.score.value;
        }
      }

      if (solvabilityCheck) {
        const ok = await solvabilityPasses(engine, fenAfter, depth, movetimeMs, abortSignal);
        if (!ok) {
          console.log(
            `${logBase} deltaW=${round3(result.deltaW)} deltaD=${round3(result.deltaD)} SKIP:solvabilityFailed`,
          );
          continue;
        }
      }

      const themes = computeTagsClient(
        fenAfter,
        wdlAfterSignedForSolver,
        isMate,
        mateDist,
      );
      const rating = computeStartingRating(wdlAfterSignedForSolver);
      console.log(
        `${logBase} wdlBefore=${round3(wdlBeforeSigned)} wdlAfter=${round3(wdlAfterSignedForSolver)} deltaW=${round3(result.deltaW)} deltaD=${round3(result.deltaD)} trigger=${result.trigger} ACCEPTED rating=${rating}`,
      );

      puzzles.push({
        fen: fenAfter,
        moves: '',
        rating,
        gap: Math.round(wdlAfterSignedForSolver * 100),
        themes: themes.join(' '),
        sourceType: 'pgn_import',
        sourceId: null,
        sourceMoveNum: moveNum,
        sourceMetadata: {
          ...metadata,
          blunderMove: playedUci,
          wdlBeforeBlunder: round3(wdlBeforeSigned),
          wdlAfterBlunder: round3(wdlAfterSignedForSolver),
          deltaW: round3(result.deltaW),
          deltaD: round3(result.deltaD),
          blunderTrigger: result.trigger,
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

// ─── PGN-парсер ───

/**
 * KS-2683: убрать комментарии `{…}`, варианты `(…)` (с поддержкой
 * вложенности), NAG-аннотации `$N`, лишние пробелы из movetext.
 *
 * Раньше использовались regex'ы `\{[^}]*\}` и `\([^)]*\)` — оба
 * нерекурсивные, на вложенных вариантах `((...))` (или комментарии,
 * содержащем `}`) ломались. Реальные PGN из chess.com / lichess
 * обычно линейные, но защититься от вложенности дёшево —
 * character-pass со счётчиком скобок надёжнее regex'ов.
 *
 * Header tags (`[Event ...]`) пропускаем — там скобки/комментарии
 * не имеют отдельного смысла.
 */
function stripPgnAnnotations(pgn: string): string {
  const lines = pgn.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('[')) {
      result.push(line);
      continue;
    }
    // Character-pass: balanced { } и ( ) с поддержкой вложенности.
    // {…} — комментарии (не вкладываются по PGN-стандарту, но
    // обрабатываем единичный уровень). (…) — варианты, могут быть
    // вложены.
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
