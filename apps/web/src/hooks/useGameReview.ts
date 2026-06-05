/**
 * KS-3603 → KS-3607 (ADR-100 §3-§4, §7.1, §9 этап B). Hook «Разобрать
 * партию»: проходит по всем полуходам, считает SF (с `UCI_ShowWDL`)
 * + Maia, прогоняет `buildAnnotation` (метрика — `classifyMove` из
 * shared) и собирает `Annotation[]`.
 *
 * KS-3607: cp-логика удалена; работаем только с `Wdl`-объектами,
 * передавая их в `buildAnnotation` в POV ходящей стороны для каждой
 * `wdlAfter*` (`invertWdl` на стороне engine-провайдера).
 *
 * Оркестрация последовательная по полуходам — на партии ~80 полуходов
 * ≤ 40с p95 (ADR-100 §7). Engine-провайдеры через DI (`ReviewEngines`)
 * — реальная реализация в `createDefaultEngines`, тестовая — мок.
 *
 * Cancel: `terminate()` обоих engine'ов; state.status → 'cancelled'.
 */
import { useCallback, useRef, useState } from 'react';
import { Chess } from 'chess.js';

import {
  classifyMove,
  invertWdl,
  type MoveClass,
  type PositionalSubterm,
  type Wdl,
} from '@kingside/shared';

import {
  postMoveComment as defaultPostMoveComment,
  type MoveCommentRequest,
} from '../api/moveComment';
import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import { uciToSan } from '../lib/maia/uciToSan';
import {
  buildAnnotation,
  pickFinalEvalNag,
  type Annotation,
  type AnnotationVariation,
  type MoveInput,
} from '../lib/review/buildAnnotations';
import { buildMoveCommentMove } from '../lib/review/buildMoveCommentMove';
import { buildSnapshotFactors } from '../lib/review/buildSnapshotFactors';
import {
  MAX_LINE_LENGTH_PLIES,
  SUB_VARIATION_MAX_LENGTH_PLIES,
} from '../lib/review/buildStabilizedLine';
import type { FactsInput } from '../lib/review/extractFacts';
import { evalTrace as evalStockfishTrace } from '../lib/review/stockfishTrace';
import {
  PositionalEvalEngine,
  type PositionalEvalEngine as PositionalEvalEngineType,
} from '../lib/review/positionalEval';

// --- engine-провайдеры (DI) ------------------------------------------------

/**
 * Результат SF-анализа позиции (multipv=N, depth=D, с UCI_ShowWDL).
 * Все `wdlAfter*` приведены к **POV ходящей стороны fenBefore** —
 * оркестратор инвертирует raw POV (после хода stm соперник).
 */
export interface SfPositionResult {
  /** UCI top-1 (sfBestUci). */
  bestUci: string;
  /** WDL до хода (POV ходящей стороны на `fenBefore`). */
  wdlBefore: Wdl;
  /** WDL после `bestUci` — POV ходящей стороны fenBefore. */
  wdlAfterBest: Wdl;
  /** WDL после SF top-2 — тот же POV. `null` если top-2 нет (1 ход). */
  wdlAfterSecondBest: Wdl | null;
  /** PV первой линии (UCI'ы). Для green-variation в §4.1. */
  bestPv: string[];
  /**
   * Полная multipv-карта `uci → wdlAfter` (POV ходящей стороны).
   * Используется чтобы достать `wdlAfterPlayed` без второго прогона,
   * если playedUci в top-N. Также для maia (если maiaTop в top-N).
   */
  wdlByMove: Record<string, Wdl>;
  /** Кол-во легальных ходов в позиции — для `forcedMove`. */
  legalMovesCount: number;
  /**
   * KS-3712: «честный» score первой линии — `cp` или `mate`, POV ходящей
   * стороны на `fen`. Используется при сборке `sf18_eval` для пары
   * `before`/`after` снимков в `move-comment`. `null` или отсутствует —
   * если движок не вернул score (старая обвязка/тестовый мок).
   * Поле опциональное ради обратной совместимости с тестами/моками.
   */
  topScore?: { type: 'cp' | 'mate'; value: number } | null;
  /**
   * KS-3712: глубина, на которой получена первая линия. Поле опциональное
   * ради обратной совместимости с тестами/моками.
   */
  topDepth?: number;
}

export interface MaiaPolicy {
  byUci: Record<string, number>;
  topUci: string;
  topProb: number;
}

export interface ReviewEngines {
  /** SF анализ позиции `fen` с multipv=N. Должен установить UCI_ShowWDL=true. */
  analyzeSf(fen: string, multipv: number, depth: number): Promise<SfPositionResult>;
  /**
   * SF eval позиции на конкретный ход (`go searchmoves <uci> multipv 1`)
   * — возвращает WDL POV ходящей стороны на той же `fen`. Используется
   * когда нужного хода нет в `analyzeSf.wdlByMove`.
   */
  evalMove(fen: string, uci: string, depth: number): Promise<Wdl>;
  /** Maia policy для позиции на заданном ELO. */
  predictMaia(fen: string, elo: number): Promise<MaiaPolicy>;
  /** Прервать любые in-flight задачи. */
  terminate(): void;
}

// --- public types ----------------------------------------------------------

export type ReviewStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'error';

/**
 * KS-3616. Клиент пакета LLM-комментариев старого формата
 * (`POST /analyses/position/comment`, list-of-FactsInput). Оставлен в
 * типе ради совместимости с `window.__sfReviewProbe` и переходного
 * периода тестов. С KS-3712 хук вызывает не этот клиент, а
 * {@link MoveCommentClient}.
 */
export type CommentClient = (
  facts: readonly FactsInput[],
  userElo: number,
  language: 'en' | 'ru',
  signal?: AbortSignal,
  options?: { onProgress?: (done: number) => void },
) => Promise<string[]>;

/**
 * KS-3712. Клиент атомарного запроса комментария к одному ходу
 * (`POST /analyses/review/move-comment`). Один ход = один запрос с
 * парой `before`/`after` снимков в формате `position-comment`.
 * Возвращает текст комментария или пустую строку при нефатальной
 * ошибке (тогда `commentByPly` не получит запись на этот ход).
 * `AbortError` пробрасывается.
 */
export type MoveCommentClient = (
  request: MoveCommentRequest,
  signal?: AbortSignal,
) => Promise<string>;

export interface UseGameReviewOptions {
  /** ELO Maia. Дефолт 1500. */
  elo?: number;
  /** SF depth. Не используется с KS-3617 (заменено на movetime). */
  depth?: number;
  /**
   * KS-3617. Время на ход в мс для Stockfish (`go movetime <N>`).
   * Дефолт 1000. Пользовательская настройка хранится в
   * `analysis.review.movetimeMs` (см. `useGameReviewMovetime`).
   */
  movetimeMs?: number;
  /** Кастомный engines-провайдер — для тестов. */
  engines?: ReviewEngines;
  /**
   * KS-3616. Включить ли фазу LLM-комментариев. По умолчанию `true`.
   * Установить `false` чтобы пропустить запрос (например, в dev/тестах).
   */
  commentsEnabled?: boolean;
  /**
   * KS-3712. DI-клиент атомарного запроса `move-comment` для unit-тестов.
   * По умолчанию — `postMoveComment` из `api/moveComment`.
   */
  moveCommentClient?: MoveCommentClient;
  /** KS-3616. Название дебюта (если резолвено caller'ом). */
  openingName?: string | null;
  /** KS-3616. Язык комментариев. Дефолт `'ru'`. */
  userLanguage?: 'en' | 'ru';
  /**
   * KS-3628 / ADR-103 §6. Фабрика клиентского SF 16 lite для
   * positional_shifts. После KS-3712 поле сохранено в типе ради
   * обратной совместимости с тестами/dev-tool'ами; реально не
   * используется — в новом payload `move-comment` поле
   * `positional_shifts` отсутствует.
   */
  createPositionalEval?: (() => PositionalEvalEngineType) | null;
}

export interface ReviewResult {
  annotations: Annotation[];
  moveInputs: MoveInput[];
  /**
   * KS-3616. Маппинг `ply (1-based) → текст LLM-комментария`. Содержит
   * только непустые строки. Если фаза комментариев была отключена или
   * провалилась — пустой объект.
   */
  commentByPly: Record<number, string>;
}

/**
 * KS-3616/KS-3618. Стадии прогресса.
 *  - `engine` — основной SF+Maia прогон (done/total + %).
 *  - `comments` — post-pass subline + LLM-комментарии (без процентов).
 *  - `creating` — POST `/duplicate-annotated` после `status='done'`.
 *    Используется launcher'ом (модалка показывает «Создаю копию…»).
 */
/**
 * KS-3677: подстадии вместо одной общей `comments`. Пользователю
 * видно, где сейчас тратится время, и прогресс-индикатор заполняется
 * на каждой подстадии отдельно.
 *  - `stabilizing` — post-pass субвариантов на красные NAG-факты.
 *  - `positional` — расчёт `positional_shifts` (PositionalEvalEngine).
 *  - `comments` — отправка пакетов на `/analyses/review/comments`.
 */
export type ReviewStage =
  | 'engine'
  | 'stabilizing'
  | 'finalEval'
  | 'positional'
  | 'finalizing'
  | 'comments'
  | 'creating';

// --- helpers ---------------------------------------------------------------

interface ParsedGameMove {
  ply: number;
  fenBefore: string;
  playedUci: string;
}

export function parsePgnPlies(pgn: string): ParsedGameMove[] {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const verbose = chess.history({ verbose: true }) as Array<{
    from: string;
    to: string;
    promotion?: string;
  }>;
  if (verbose.length === 0) return [];

  const headers = chess.header();
  const replay = new Chess();
  if (headers.SetUp === '1' && headers.FEN) {
    try {
      replay.load(headers.FEN);
    } catch {
      /* ignore */
    }
  }
  const result: ParsedGameMove[] = [];
  for (let i = 0; i < verbose.length; i++) {
    const m = verbose[i];
    const fenBefore = replay.fen();
    const playedUci = `${m.from}${m.to}${m.promotion ?? ''}`;
    result.push({ ply: i + 1, fenBefore, playedUci });
    try {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      break;
    }
  }
  return result;
}

function isForcedMove(legalMovesCount: number): boolean {
  return legalMovesCount <= 1;
}

// --- default engines (real SF + Maia) --------------------------------------

/**
 * KS-3607. Реальная SF-обвязка теперь парсит и `wdl w d l` из info-строк
 * (требует `UCI_ShowWDL=true`). Stockfish 18 с wasm-сборки этого
 * проекта поддерживает опцию (см. KS-2431).
 *
 * KS-3617: на каждый полуход даём фиксированный movetime (по умолчанию
 * 1 сек), а не фиксированную глубину. Пользовательская настройка —
 * `analysis.review.movetimeMs` через `useGameReviewMovetime`.
 */
export function createDefaultEngines(movetimeMs: number = 1000): ReviewEngines {
  let sfWorker: Worker | null = null;
  let initialised = false;
  let pendingResolve:
    | ((
        lines: Array<{
          multipv: number;
          pv: string[];
          wdl: Wdl | null;
          score: { type: 'cp' | 'mate'; value: number } | null;
          depth: number;
        }>,
      ) => void)
    | null = null;
  let pendingBuf: Array<{
    multipv: number;
    pv: string[];
    wdl: Wdl | null;
    score: { type: 'cp' | 'mate'; value: number } | null;
    depth: number;
  }> = [];
  let pendingExpectedMpv = 1;

  function ensureSf(): Promise<Worker> {
    if (sfWorker && initialised) return Promise.resolve(sfWorker);
    if (!sfWorker) sfWorker = new Worker('/stockfish/stockfish-18-lite.js');
    const w = sfWorker;
    return new Promise((resolve) => {
      const onInit = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data);
        if (line === 'uciok') {
          w.postMessage('setoption name UCI_ShowWDL value true');
          w.postMessage('isready');
        } else if (line === 'readyok') {
          initialised = true;
          w.removeEventListener('message', onInit);
          w.addEventListener('message', onSfMessage);
          resolve(w);
        }
      };
      w.addEventListener('message', onInit);
      w.postMessage('uci');
    });
  }

  function onSfMessage(e: MessageEvent) {
    const line = typeof e.data === 'string' ? e.data : String(e.data);
    if (line.startsWith('info ') && line.includes(' pv ')) {
      const d = parseInfo(line);
      if (d) {
        pendingBuf = pendingBuf.filter((l) => l.multipv !== d.multipv);
        pendingBuf.push(d);
      }
      return;
    }
    if (line.startsWith('bestmove')) {
      const result = [...pendingBuf].sort((a, b) => a.multipv - b.multipv);
      pendingBuf = [];
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve?.(result.slice(0, pendingExpectedMpv));
    }
  }

  function parseInfo(
    line: string,
  ): {
    multipv: number;
    pv: string[];
    wdl: Wdl | null;
    /** KS-3712: cp/mate score, POV ходящей на анализируемой позиции. */
    score: { type: 'cp' | 'mate'; value: number } | null;
    /** KS-3712: глубина info-строки (для информационного поля sf18_eval). */
    depth: number;
  } | null {
    const mpvM = line.match(/\bmultipv (\d+)/);
    const pvM = line.match(/\bpv (.+)/);
    const wdlM = line.match(/\bwdl (\d+) (\d+) (\d+)/);
    const cpM = line.match(/\bscore cp (-?\d+)/);
    const mateM = line.match(/\bscore mate (-?\d+)/);
    const depthM = line.match(/\bdepth (\d+)/);
    if (!pvM) return null;
    const wdl = wdlM
      ? { w: Number(wdlM[1]), d: Number(wdlM[2]), l: Number(wdlM[3]) }
      : null;
    const score: { type: 'cp' | 'mate'; value: number } | null = mateM
      ? { type: 'mate', value: Number(mateM[1]) }
      : cpM
        ? { type: 'cp', value: Number(cpM[1]) }
        : null;
    return {
      multipv: Number(mpvM?.[1] ?? 1),
      pv: pvM[1].split(' '),
      wdl,
      score,
      depth: depthM ? Number(depthM[1]) : 0,
    };
  }

  async function runGo(
    fen: string,
    multipv: number,
    _depth: number,
    searchmoves?: string[],
  ) {
    // KS-3617: на каждый полуход даём фиксированный movetime в мс
    // (дефолт 1 секунда). Аргумент `depth` остался в сигнатуре для
    // обратной совместимости с моками/тестами, но фактически
    // игнорируется. Пользовательская настройка — `useGameReviewMovetime`.
    void _depth;
    const w = await ensureSf();
    return new Promise<
      Array<{
        multipv: number;
        pv: string[];
        wdl: Wdl | null;
        score: { type: 'cp' | 'mate'; value: number } | null;
        depth: number;
      }>
    >((resolve) => {
      pendingResolve = resolve;
      pendingBuf = [];
      pendingExpectedMpv = multipv;
      w.postMessage('ucinewgame');
      w.postMessage(`setoption name MultiPV value ${multipv}`);
      w.postMessage(`position fen ${fen}`);
      const sm =
        searchmoves && searchmoves.length > 0
          ? ` searchmoves ${searchmoves.join(' ')}`
          : '';
      w.postMessage(`go movetime ${movetimeMs}${sm}`);
    });
  }

  /**
   * SF возвращает `wdl` POV side-to-move позиции, в которой стоит её
   * info. Для multipv'ов на `fenBefore` это POV ходящей стороны
   * **fenBefore** уже — потому что info идёт до сделанного хода.
   * Stockfish при `multipv N` оценивает позицию `fenBefore` после
   * каждого из N ходов в head-of-PV, но `wdl` в info — это всё ещё
   * **POV ходящей стороны на fenBefore** (см. UCI спецификация
   * Stockfish 18 + ADR-066 §3.2). Поэтому здесь дополнительно
   * инвертировать НЕ нужно — всё уже в нужном POV. (KS-3607 архитектура.)
   *
   * Для отдельного `searchmoves <uci>` той же позиции — также POV
   * ходящей стороны fenBefore.
   */
  let maiaEngine: MaiaWorkerEngine | null = null;
  function ensureMaia(): MaiaWorkerEngine {
    if (!maiaEngine) maiaEngine = new MaiaWorkerEngine();
    return maiaEngine;
  }

  return {
    async analyzeSf(fen, multipv, depth) {
      const lines = await runGo(fen, multipv, depth);
      const wdlByMove: Record<string, Wdl> = {};
      for (const l of lines) {
        const first = l.pv?.[0];
        if (first && l.wdl) wdlByMove[first] = l.wdl;
      }
      const top = lines[0];
      const second = lines[1];
      const chess = new Chess();
      let legalMoves = 0;
      try {
        chess.load(fen);
        legalMoves = chess.moves().length;
      } catch {
        legalMoves = 1;
      }
      // KS-3607: `wdlBefore` приходит как `wdl` верхней линии — это
      // позиция fenBefore POV ходящей стороны. Если UCI_ShowWDL не
      // дал значения (старая wasm-сборка?) — заглушка {500,0,500}
      // (нейтральная), чтобы classifyMove не падал на mate-edge.
      const wdlBefore: Wdl =
        top?.wdl ?? { w: 500, d: 0, l: 500 };
      const wdlAfterBest: Wdl =
        top?.wdl ?? { w: 500, d: 0, l: 500 };
      const wdlAfterSecondBest: Wdl | null = second?.wdl ?? null;
      return {
        bestUci: top?.pv[0] ?? '',
        wdlBefore,
        wdlAfterBest,
        wdlAfterSecondBest,
        bestPv: top?.pv ?? [],
        wdlByMove,
        legalMovesCount: legalMoves,
        topScore: top?.score ?? null,
        topDepth: top?.depth ?? 0,
      };
    },
    async evalMove(fen, uci, depth) {
      const lines = await runGo(fen, 1, depth, [uci]);
      const top = lines[0];
      return top?.wdl ?? { w: 500, d: 0, l: 500 };
    },
    async predictMaia(fen, elo) {
      const eng = ensureMaia();
      const result = await eng.predictMoves(fen, elo, elo);
      const byUci: Record<string, number> = {};
      for (const m of result.policy) byUci[m.move] = m.probability;
      const top = result.policy[0];
      return {
        byUci,
        topUci: top?.move ?? '',
        topProb: top?.probability ?? 0,
      };
    },
    terminate() {
      if (sfWorker) {
        try {
          sfWorker.postMessage('quit');
        } catch {
          /* ignore */
        }
        sfWorker.terminate();
        sfWorker = null;
        initialised = false;
      }
      if (maiaEngine) {
        maiaEngine.terminate();
        maiaEngine = null;
      }
    },
  };
}

// --- hook ------------------------------------------------------------------

export function useGameReview(options: UseGameReviewOptions = {}) {
  const {
    elo = 1500,
    depth = 18,
    movetimeMs = 1000,
    engines: injectedEngines,
    commentsEnabled = true,
    moveCommentClient = defaultPostMoveComment,
    openingName = null,
    userLanguage = 'ru',
    createPositionalEval,
  } = options;
  // KS-3712: `openingName` сохранён в API ради совместимости с
  // вызывающими компонентами, но в новом payload `move-comment`
  // не используется (модель получает обе позиции через FEN).
  void openingName;
  const [status, setStatus] = useState<ReviewStatus>('idle');
  const [progress, setProgress] = useState<{
    stage: ReviewStage;
    done: number;
    total: number;
  }>({ stage: 'engine', done: 0, total: 0 });
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<ReviewResult | undefined>(undefined);
  // KS-3616. Если LLM не дал комментарии — UI показывает toast/баннер,
  // не блокируя success-флоу (дубль создаётся в любом случае).
  const [commentsWarning, setCommentsWarning] = useState<boolean>(false);

  const cancelRef = useRef(false);
  const enginesRef = useRef<ReviewEngines | null>(null);
  // KS-3616. Для отмены LLM-fetch'а во время comments-стадии.
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (pgn: string): Promise<void> => {
      cancelRef.current = false;
      setError(undefined);
      setResult(undefined);
      setCommentsWarning(false);
      setStatus('running');
      // KS-3677: общий старт прогона — нужен для логов с относительными
      // временными метками.
      const reviewStartedAt = performance.now();

      let plies: ParsedGameMove[];
      try {
        plies = parsePgnPlies(pgn);
      } catch (e) {
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (plies.length === 0) {
        setStatus('error');
        setError('empty_game');
        return;
      }
      setProgress({ stage: 'engine', done: 0, total: plies.length });

      const engines = injectedEngines ?? createDefaultEngines(movetimeMs);
      enginesRef.current = engines;

      // KS-3617: убран `sfCache`/`maiaCache`. В партии без повторов
      // позиции уникальные — кэш не приносит экономии, но скрывал
      // главную причину фиксированной длины вариантов: post-pass
      // ходил в пустой кэш и обрывал линию на 1 ходу, далее
      // buildAnnotations падал в фолбэк `sfBestPv.slice(1, 3)`.

      const moveInputs: MoveInput[] = [];
      // KS-3712: snapshot топ-1 score и depth Stockfish для позиции ПЕРЕД
      // каждым полуходом — пригодится в comments-фазе для `before.factors`
      // (`sf18_eval`/`sf18_pv`). Размер = `plies.length`, индекс = i.
      const sfBeforeByIndex: Array<{
        topScore: { type: 'cp' | 'mate'; value: number } | null;
        topDepth: number;
        topPv: string[];
      } | null> = [];

      try {
        for (let i = 0; i < plies.length; i++) {
          if (cancelRef.current) {
            engines.terminate();
            enginesRef.current = null;
            setStatus('cancelled');
            return;
          }
          const { ply, fenBefore, playedUci } = plies[i];

          // SF на fenBefore: multipv=3 + UCI_ShowWDL → набор WDL.
          const sf = await engines.analyzeSf(fenBefore, 3, depth);
          sfBeforeByIndex.push({
            topScore: sf.topScore ?? null,
            topDepth: sf.topDepth ?? 0,
            topPv: sf.bestPv ?? [],
          });

          // Maia policy.
          const maia = await engines.predictMaia(fenBefore, elo);

          // wdlAfterPlayed: если в top-3 — берём оттуда, иначе ещё
          // один SF-go с searchmoves <playedUci>.
          let wdlAfterPlayed: Wdl;
          if (sf.wdlByMove[playedUci]) {
            wdlAfterPlayed = sf.wdlByMove[playedUci];
          } else {
            wdlAfterPlayed = await engines.evalMove(
              fenBefore,
              playedUci,
              depth,
            );
          }

          // wdlAfterMaiaTop: берём из multipv-карты если Maia-top
          // совпадает с одним из SF top-N. Если нет — делаем
          // отдельный `evalMove(fenBefore, maiaTop)`, как уже сделано
          // для playedUci. Раньше при miss отдавали undefined и red-
          // вариация скипалась целиком; но именно «человек чаще играет
          // плохо и SF не считает этот ход топом» — основной use-case
          // Maia-альтернативы. Прежний компромисс ADR-100 §7 не имел
          // смысла, переоцениваем.
          //
          // Дубль не делаем: если maiaTop == playedUci — берём
          // wdlAfterPlayed (уже посчитан); если == sfBestUci — берём
          // wdlAfterBest.
          let wdlAfterMaiaTop: Wdl | undefined;
          if (!maia.topUci) {
            wdlAfterMaiaTop = undefined;
          } else if (maia.topUci === playedUci) {
            wdlAfterMaiaTop = wdlAfterPlayed;
          } else if (maia.topUci === sf.bestUci) {
            wdlAfterMaiaTop = sf.wdlAfterBest;
          } else if (sf.wdlByMove[maia.topUci]) {
            wdlAfterMaiaTop = sf.wdlByMove[maia.topUci];
          } else {
            try {
              wdlAfterMaiaTop = await engines.evalMove(
                fenBefore,
                maia.topUci,
                depth,
              );
            } catch {
              wdlAfterMaiaTop = undefined;
            }
          }

          const input: MoveInput = {
            ply,
            fen: fenBefore,
            playedUci,
            sfBestUci: sf.bestUci,
            wdlBefore: sf.wdlBefore,
            wdlAfterPlayed,
            wdlAfterBest: sf.wdlAfterBest,
            wdlAfterSecondBest: sf.wdlAfterSecondBest,
            wdlAfterMaiaTop,
            sfBestPv: sf.bestPv,
            playedProb: maia.byUci[playedUci],
            sfBestProb: maia.byUci[sf.bestUci],
            maiaTopUci: maia.topUci,
            maiaTopProb: maia.topProb,
            forcedMove: isForcedMove(sf.legalMovesCount),
          };
          moveInputs.push(input);
          setProgress({ stage: 'engine', done: i + 1, total: plies.length });
        }
      } catch (e) {
        engines.terminate();
        enginesRef.current = null;
        setStatus('error');
        // KS-3677: системную поломку исполнителя SF-trace помечаем
        // отдельным ключом — UI покажет понятное сообщение
        // «Не удалось запустить позиционный анализ».
        if (
          e &&
          typeof e === 'object' &&
          (e as { name?: string }).name === 'StockfishTraceEngineError'
        ) {
          setError('stockfish_trace_unavailable');
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }

      // KS-3618 → KS-3677. После main-pass'а идёт сначала post-pass
      // (стабилизация субвариантов на красные NAG-факты, ~1 с/ход).
      // Стадия `stabilizing` — пользователю видно конкретный текст
      // «Стабилизация вариантов» в модалке. `total` ставится по числу
      // факт-сборок, накопленных в main-pass'е, `done` тикает по
      // мере обработки.
      console.info(
        `[useGameReview] stage → stabilizing (moves=${moveInputs.length}, t=+${Math.round(performance.now() - reviewStartedAt)}ms)`,
      );
      // KS-3678. Реальный прогресс по ходам: до этого `total=0` давал
      // пустой индикатор, который браузер рендерил «полным» и создавал
      // ложное впечатление зависания. Теперь видно `12 / 47`.
      setProgress({
        stage: commentsEnabled ? 'stabilizing' : 'finalizing',
        done: 0,
        total: moveInputs.length,
      });
      const stabilizeStart = performance.now();

      // KS-3617. Subline'ы вариантов:
      //   - green: берётся напрямую из `sf.bestPv` (уже посчитано на
      //     main-pass'е) — это PV1 от Stockfish на полную глубину.
      //     `slice(1, MAX)` отрезает первый ход (= uci ветки) и cap'ит
      //     длину. Никаких лишних SF-вызовов.
      //   - red: PV1 на main-pass'е считалась от played-хода, не от
      //     maiaTop. Делаем один доп. SF-вызов от позиции после maiaTop,
      //     берём PV1 длиной cap=SUB. Без этого вызова продолжение
      //     красного варианта отсутствует.
      function applyMove(fen: string, uci: string): string | null {
        try {
          const b = new Chess(fen);
          const m = b.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            promotion: uci.length > 4 ? uci[4] : undefined,
          });
          return m ? b.fen() : null;
        } catch {
          return null;
        }
      }

      for (let mi = 0; mi < moveInputs.length; mi++) {
        const input = moveInputs[mi];
        if (cancelRef.current) break;
        // KS-3678: лог раз в 10 ходов + обновление прогресс-индикатора
        // на каждой итерации. Без этого стадия выглядела «зависшей».
        if (mi > 0 && mi % 10 === 0) {
          console.info(
            `[useGameReview] stabilizing ${mi}/${moveInputs.length} (t=+${Math.round(performance.now() - reviewStartedAt)}ms, +${Math.round(performance.now() - stabilizeStart)}ms in stage)`,
          );
        }
        // green: subline из PV1 main-pass'а (без extra SF-вызовов).
        if (
          input.sfBestUci &&
          input.sfBestUci !== input.playedUci &&
          input.sfBestPv &&
          input.sfBestPv.length > 1
        ) {
          input.sfBestSubline = input.sfBestPv.slice(
            1,
            MAX_LINE_LENGTH_PLIES,
          );
          // KS-3637 (ADR-105 §3.3). WDL в конце subline POV игрока,
          // начинавшего ветку, нужен для запрета «!» в проигранной
          // зелёной вариации (`maybeGreenVariation`). PV-based subline
          // не даёт промежуточных WDL'ов, поэтому делаем один SF-вызов
          // на финальной позиции subline (~1 на ход-ошибку = +N вызовов
          // на партию). Граceful: при ошибке оставляем поле undefined,
          // `buildAnnotations` сделает fallback на `wdlAfterBest`.
          try {
            let finalFen: string | null = input.fen;
            for (const u of [input.sfBestUci, ...input.sfBestSubline]) {
              if (!finalFen) break;
              finalFen = applyMove(finalFen, u);
            }
            if (finalFen) {
              const sub = await engines.analyzeSf(finalFen, 1, depth);
              // sub.wdlBefore — POV STM на finalFen. Игрок, начинавший
              // ветку = STM на input.fen. STM чередуется по полуходам.
              const plies = 1 + input.sfBestSubline.length;
              const sameSide = plies % 2 === 0;
              const wdlStmFinal = sub.wdlBefore;
              input.sfBestSublineFinalWdl = sameSide
                ? wdlStmFinal
                : {
                    w: wdlStmFinal.l,
                    d: wdlStmFinal.d,
                    l: wdlStmFinal.w,
                  };
            }
          } catch {
            /* fallthrough — fallback на wdlAfterBest в buildAnnotations */
          }
        }
        // red: отдельный SF от позиции после maiaTop, cap=SUB.
        if (input.wdlAfterMaiaTop && input.maiaTopUci) {
          const fenAfterMaia = applyMove(input.fen, input.maiaTopUci);
          if (fenAfterMaia) {
            try {
              const sub = await engines.analyzeSf(fenAfterMaia, 1, depth);
              if (sub.bestPv && sub.bestPv.length > 0) {
                input.maiaTopSubline = sub.bestPv.slice(
                  0,
                  SUB_VARIATION_MAX_LENGTH_PLIES,
                );
              }
            } catch {
              /* fallthrough — без subline */
            }
          }
        }
        // KS-3678: тикаем прогресс на каждой итерации цикла стабилизации.
        setProgress({
          stage: commentsEnabled ? 'stabilizing' : 'finalizing',
          done: mi + 1,
          total: moveInputs.length,
        });
      }
      console.info(
        `[useGameReview] stabilizing done in ${Math.round(performance.now() - stabilizeStart)}ms`,
      );

      const annotations: Annotation[] = moveInputs.map(buildAnnotation);

      // KS-3617. Nested-pass отключён в этой итерации. Прежняя
      // реализация работала через sfCache/maiaCache main-pass'а — но
      // позиции внутри вариантов в этом кэше отсутствовали, поэтому
      // nested либо не строился, либо строился по устаревшим данным
      // (и давал дубли вроде «58.b3?? (58.b3??)»). Возврат фичи —
      // отдельной задачей через async-движки и собственный budget на
      // дополнительные SF/Maia-вызовы.

      // KS-3619: position-eval NAG (11/14-19) на финальной позиции
      // каждой ветки. Для каждой main-variation проигрываем все её
      // ходы (uci + subline), берём WDL финальной позиции одним SF-
      // вызовом и присваиваем variation.finalEvalNag.
      async function annotateFinalEval(
        variation: AnnotationVariation,
        startFen: string,
      ): Promise<void> {
        const ucis = [variation.uci, ...(variation.subline ?? [])];
        let cur: string | null = startFen;
        for (const u of ucis) {
          if (!cur) break;
          cur = applyMove(cur, u);
        }
        if (!cur) return;
        // KS-3619 follow-up: на терминальной позиции (мат/пат/ничья) SF
        // не отдаёт осмысленный WDL — `pickFinalEvalNag` падает в `=`,
        // и в варианте, заканчивающемся матом, появлялся $11 вместо
        // $18/$19. Различаем результат через chess.js напрямую, без
        // SF-вызова на терминалках.
        try {
          const board = new Chess(cur);
          if (board.isCheckmate()) {
            // На ходу — проигравшая сторона. white получил мат → −+ (19),
            // black получил мат → +− (18).
            const stmIsWhite = cur.split(' ')[1] === 'w';
            variation.finalEvalNag = stmIsWhite ? 19 : 18;
            return;
          }
          if (
            board.isStalemate() ||
            board.isInsufficientMaterial() ||
            board.isDraw()
          ) {
            variation.finalEvalNag = 11;
            return;
          }
        } catch {
          /* chess.js падает — продолжим обычным SF-путём */
        }
        try {
          const sub = await engines.analyzeSf(cur, 1, depth);
          if (!sub.wdlBefore) return;
          const stmIsWhite = cur.split(' ')[1] === 'w';
          variation.finalEvalNag = pickFinalEvalNag(
            sub.wdlBefore,
            stmIsWhite,
          );
        } catch {
          /* graceful — без оценочного NAG */
        }
        // Рекурсивно — на случай если nested-pass снова включится.
        for (const perNode of variation.nestedVariations ?? []) {
          for (const child of perNode) {
            await annotateFinalEval(child, startFen);
          }
        }
      }

      // KS-3678. annotateFinalEval делает 1 SF-вызов на каждый
      // вариант — итого до N (annotation) × M (variations) вызовов.
      // Раньше всё это шло без отдельного индикатора и сливалось со
      // «стабилизацией». Теперь — отдельная подстадия `finalEval` с
      // прогрессом по аннотациям.
      console.info(
        `[useGameReview] stage → finalEval (annotations=${annotations.length}, t=+${Math.round(performance.now() - reviewStartedAt)}ms)`,
      );
      const finalEvalStart = performance.now();
      setProgress({
        stage: 'finalEval',
        done: 0,
        total: annotations.length,
      });
      for (let i = 0; i < annotations.length; i++) {
        if (cancelRef.current) break;
        const ann = annotations[i];
        if (ann.variations.length === 0) {
          setProgress({
            stage: 'finalEval',
            done: i + 1,
            total: annotations.length,
          });
          continue;
        }
        const fenAtMainMove = moveInputs[i].fen;
        for (const variation of ann.variations) {
          if (cancelRef.current) break;
          await annotateFinalEval(variation, fenAtMainMove);
        }
        setProgress({
          stage: 'finalEval',
          done: i + 1,
          total: annotations.length,
        });
      }
      console.info(
        `[useGameReview] finalEval done in ${Math.round(performance.now() - finalEvalStart)}ms`,
      );

      // KS-3616 (ADR-102 §7 этап C). Фаза LLM-комментариев. Собираем
      // facts только для ходов с NAG-меткой (только main-line), шлём
      // одним батчем. Любая ошибка backend'а — graceful: пустой
      // commentByPly + флаг warning (UI покажет toast).
      const commentByPly: Record<number, string> = {};
      if (commentsEnabled && !cancelRef.current) {
        // KS-3679. Подготовка фактов перед LLM вызывает evalStockfishTrace
        // на каждом NAG-ходе. Если исполнитель WASM выбросит
        // StockfishTraceEngineError — раньше она улетала за пределы
        // всех обработчиков и UI висел навсегда. Оборачиваем весь блок
        // (factsToSend + positional_shifts + LLM batch) в try/catch.
        const llmPrepStart = performance.now();
        console.info(
          `[useGameReview] stage → factsCollect (annotations=${annotations.length}, t=+${Math.round(performance.now() - reviewStartedAt)}ms)`,
        );
        try {
        // KS-3712: новый формат полного разбора — атомарные запросы на
        // `POST /analyses/review/move-comment`. Для каждого NAG-хода
        // собираем пару снимков `before`/`after` в формате
        // `position-comment` (`fen` + список факторов: позиционные
        // подкомпоненты от `evalTrace` + `sf18_eval`/`sf18_pv`). Затем
        // шлём задания по очереди с малым параллелизмом — KS-3711
        // подтвердил лимит 60/мин, на партию из 30 ходов хватает.
        //
        // `createPositionalEval` (вычисление `positional_shifts`) и
        // `extractFacts` (старый DTO `FactsInput`) больше не нужны —
        // в новом payload этих полей нет.
        void createPositionalEval;
        void PositionalEvalEngine;
        type MoveCommentTask = { ply: number; request: MoveCommentRequest };
        const tasks: MoveCommentTask[] = [];

        for (let i = 0; i < annotations.length; i++) {
          const ann = annotations[i];
          if (ann.nag.length === 0) continue;
          if (cancelRef.current) break;
          const input = moveInputs[i];
          const fenBefore = input.fen;
          const fenAfter = applyMove(fenBefore, input.playedUci) ?? fenBefore;

          // before-снимок: позиционные подкомпоненты от stockfish-16-trace.
          // Один повтор при сбое. Пусто → ход пропускаем (без подкомпонент
          // модель сваливается в шаблонный текст).
          let beforeSubterms: PositionalSubterm[] = [];
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              beforeSubterms = await evalStockfishTrace(fenBefore);
              break;
            } catch (err) {
              console.warn(
                `[useGameReview] evalStockfishTrace(before) failed for ply=${input.ply} (attempt ${attempt}/2):`,
                err,
              );
              beforeSubterms = [];
            }
          }
          if (beforeSubterms.length === 0) {
            console.warn(
              `[useGameReview] ply=${input.ply} skipped (empty subterms on fenBefore)`,
            );
            continue;
          }
          if (cancelRef.current) break;

          // after-снимок: тот же приём.
          let afterSubterms: PositionalSubterm[] = [];
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              afterSubterms = await evalStockfishTrace(fenAfter);
              break;
            } catch (err) {
              console.warn(
                `[useGameReview] evalStockfishTrace(after) failed for ply=${input.ply} (attempt ${attempt}/2):`,
                err,
              );
              afterSubterms = [];
            }
          }
          if (afterSubterms.length === 0) {
            console.warn(
              `[useGameReview] ply=${input.ply} skipped (empty subterms on fenAfter)`,
            );
            continue;
          }
          if (cancelRef.current) break;

          // Дополнительный SF-анализ позиции после played-хода (нужны
          // `score` и `bestPv` для `sf18_eval`/`sf18_pv` в `after.factors`).
          // multipv=1 + те же engines, что и в main-pass — экземпляр
          // движка один, параллельных Stockfish не создаём.
          let sfAfter: SfPositionResult | null = null;
          try {
            sfAfter = await engines.analyzeSf(fenAfter, 1, depth);
          } catch (err) {
            console.warn(
              `[useGameReview] analyzeSf(after) failed for ply=${input.ply}, skipping:`,
              err,
            );
            continue;
          }
          if (cancelRef.current) break;

          // Класс хода (best/good/inaccuracy/mistake/blunder) — нужен в
          // поле `move.classification` нового payload.
          const klass: MoveClass = classifyMove({
            wdlBefore: input.wdlBefore,
            wdlAfter: input.wdlAfterPlayed,
            isBestMove: input.playedUci === input.sfBestUci,
          });
          const playedSan = uciToSan(fenBefore, input.playedUci);

          const move = buildMoveCommentMove({
            fenBefore,
            uci: input.playedUci,
            playedSan,
            classification: klass,
            engineMateAfter:
              sfAfter.topScore?.type === 'mate'
                ? sfAfter.topScore.value
                : null,
          });

          const sfBefore = sfBeforeByIndex[i];
          const before = buildSnapshotFactors({
            fen: fenBefore,
            subterms: beforeSubterms,
            engine: sfBefore
              ? {
                  score: sfBefore.topScore,
                  depth: sfBefore.topDepth,
                  pv: sfBefore.topPv,
                }
              : null,
          });
          const after = buildSnapshotFactors({
            fen: fenAfter,
            subterms: afterSubterms,
            engine: {
              score: sfAfter.topScore ?? null,
              depth: sfAfter.topDepth ?? 0,
              pv: sfAfter.bestPv ?? [],
            },
          });

          tasks.push({
            ply: input.ply,
            request: { move, before, after, language: userLanguage },
          });
        }

        if (tasks.length > 0 && !cancelRef.current) {
          console.info(
            `[useGameReview] stage → comments (tasks=${tasks.length}, t=+${Math.round(performance.now() - reviewStartedAt)}ms)`,
          );
          setProgress({
            stage: 'comments',
            done: 0,
            total: tasks.length,
          });
          abortRef.current = new AbortController();
          const signal = abortRef.current.signal;
          const llmStart = performance.now();

          // Малый параллелизм: при лимите бэкенда 60/мин (KS-3711) и
          // ~1с/ответ от модели три воркера дают комфортную скорость без
          // упора в потолок. Прогресс — по факту прихода ответов.
          const CONCURRENCY = 3;
          let nextIdx = 0;
          let done = 0;
          let nonEmpty = 0;
          let aborted = false;

          const isAbortError = (err: unknown) =>
            (err instanceof DOMException && err.name === 'AbortError') ||
            (err instanceof Error && err.name === 'AbortError');

          const worker = async (): Promise<void> => {
            while (!cancelRef.current && !aborted) {
              const idx = nextIdx++;
              if (idx >= tasks.length) return;
              const { ply, request } = tasks[idx];
              try {
                const text = await moveCommentClient(request, signal);
                if (cancelRef.current) return;
                const trimmed = text.trim();
                if (trimmed) {
                  commentByPly[ply] = trimmed;
                  nonEmpty++;
                }
              } catch (err) {
                if (isAbortError(err)) {
                  aborted = true;
                  return;
                }
                // Прочие сбои — пустой комментарий, продолжаем.
              }
              done++;
              setProgress({
                stage: 'comments',
                done,
                total: tasks.length,
              });
            }
          };
          const workerCount = Math.max(
            1,
            Math.min(CONCURRENCY, tasks.length),
          );
          await Promise.all(
            Array.from({ length: workerCount }, () => worker()),
          );
          abortRef.current = null;
          if (aborted || cancelRef.current) {
            engines.terminate();
            enginesRef.current = null;
            setStatus('cancelled');
            return;
          }
          if (nonEmpty === 0) setCommentsWarning(true);
          console.info(
            `[useGameReview] move-comment done in ${Math.round(performance.now() - llmStart)}ms (nonEmpty=${nonEmpty}/${tasks.length})`,
          );
        }
        } catch (prepErr) {
          // KS-3679: системная поломка SF-trace / позиционного исполнителя
          // в подготовке перед LLM. Без этого catch ошибка улетала
          // выше run() как unhandled rejection, UI оставался в
          // `status='running'` навсегда. Теперь — явная ошибка
          // с возможностью повторить.
          console.warn(
            `[useGameReview] factsCollect/positional/comments failed after ${Math.round(performance.now() - llmPrepStart)}ms:`,
            prepErr,
          );
          engines.terminate();
          enginesRef.current = null;
          setStatus('error');
          if (
            prepErr &&
            typeof prepErr === 'object' &&
            (prepErr as { name?: string }).name === 'StockfishTraceEngineError'
          ) {
            setError('stockfish_trace_unavailable');
          } else {
            setError(
              prepErr instanceof Error ? prepErr.message : String(prepErr),
            );
          }
          return;
        }
      }

      engines.terminate();
      enginesRef.current = null;

      setResult({ annotations, moveInputs, commentByPly });
      setStatus('done');
    },
    [elo, depth, movetimeMs, injectedEngines, commentsEnabled, moveCommentClient, userLanguage, createPositionalEval],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
    // KS-3616: оборвать LLM-fetch если он сейчас в полёте.
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch {
        /* ignore */
      }
      abortRef.current = null;
    }
    if (enginesRef.current) {
      enginesRef.current.terminate();
      enginesRef.current = null;
    }
    setStatus((prev) => (prev === 'running' ? 'cancelled' : prev));
  }, []);

  const reset = useCallback(() => {
    cancelRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    enginesRef.current?.terminate();
    enginesRef.current = null;
    setStatus('idle');
    setError(undefined);
    setResult(undefined);
    setCommentsWarning(false);
    setProgress({ stage: 'engine', done: 0, total: 0 });
  }, []);

  // Подавляем "unused-import" предупреждение про `invertWdl` — он
  // экспортирован для будущих use-case'ов (например когда SF wasm
  // изменит POV-конвенцию). Сейчас info-WDL уже в нужном POV.
  void invertWdl;

  return {
    status,
    progress,
    error,
    result,
    /** KS-3616. `true` если LLM-фаза не выдала ни одного непустого комментария. */
    commentsWarning,
    run,
    cancel,
    reset,
  };
}
