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

import { invertWdl, type Wdl } from '@kingside/shared';

import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import {
  buildAnnotation,
  type Annotation,
  type MoveInput,
} from '../lib/review/buildAnnotations';
import {
  buildStabilizedLine,
  MAX_LINE_LENGTH_PLIES,
  SUB_VARIATION_MAX_LENGTH_PLIES,
  type StabilizedEngines,
  type StabilizedFirstMove,
} from '../lib/review/buildStabilizedLine';
import {
  buildNestedVariations,
  makeBudget,
  type NestedBuilderEngines,
} from '../lib/review/buildNestedVariations';

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

export interface UseGameReviewOptions {
  /** ELO Maia. Дефолт 1500. */
  elo?: number;
  /** SF depth. ADR-100 §7: 18 default. */
  depth?: number;
  /** Кастомный engines-провайдер — для тестов. */
  engines?: ReviewEngines;
}

export interface ReviewResult {
  annotations: Annotation[];
  moveInputs: MoveInput[];
}

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
 */
export function createDefaultEngines(): ReviewEngines {
  let sfWorker: Worker | null = null;
  let initialised = false;
  let pendingResolve:
    | ((lines: Array<{ multipv: number; pv: string[]; wdl: Wdl | null }>) => void)
    | null = null;
  let pendingBuf: Array<{ multipv: number; pv: string[]; wdl: Wdl | null }> = [];
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
  ): { multipv: number; pv: string[]; wdl: Wdl | null } | null {
    const mpvM = line.match(/\bmultipv (\d+)/);
    const pvM = line.match(/\bpv (.+)/);
    const wdlM = line.match(/\bwdl (\d+) (\d+) (\d+)/);
    if (!pvM) return null;
    const wdl = wdlM
      ? { w: Number(wdlM[1]), d: Number(wdlM[2]), l: Number(wdlM[3]) }
      : null;
    return {
      multipv: Number(mpvM?.[1] ?? 1),
      pv: pvM[1].split(' '),
      wdl,
    };
  }

  async function runGo(
    fen: string,
    multipv: number,
    depth: number,
    searchmoves?: string[],
  ) {
    const w = await ensureSf();
    return new Promise<
      Array<{ multipv: number; pv: string[]; wdl: Wdl | null }>
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
      w.postMessage(`go depth ${depth}${sm}`);
    });
  }

  function whoToMove(fen: string): 'w' | 'b' {
    return fen.split(' ')[1] === 'b' ? 'b' : 'w';
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
  const { elo = 1500, depth = 18, engines: injectedEngines } = options;
  const [status, setStatus] = useState<ReviewStatus>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<ReviewResult | undefined>(undefined);

  const cancelRef = useRef(false);
  const enginesRef = useRef<ReviewEngines | null>(null);

  const run = useCallback(
    async (pgn: string): Promise<void> => {
      cancelRef.current = false;
      setError(undefined);
      setResult(undefined);
      setStatus('running');

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
      setProgress({ done: 0, total: plies.length });

      const engines = injectedEngines ?? createDefaultEngines();
      enginesRef.current = engines;

      // KS-3610 (ADR-101 §4): in-memory кэш SF-результатов по FEN.
      // Используется для:
      //  - main-pass: переиспользуем `analyzeSf` если позиция уже
      //    встречалась (transpositions);
      //  - построения stabilized subline (LINE_DEPTH=14) после
      //    основного прогона: тот же `engineGetBestLine` ходит в кэш.
      const sfCache = new Map<string, SfPositionResult>();
      async function getSf(fen: string): Promise<SfPositionResult> {
        const hit = sfCache.get(fen);
        if (hit) return hit;
        const res = await engines.analyzeSf(fen, 3, depth);
        sfCache.set(fen, res);
        return res;
      }

      // KS-3610: maia-кэш по FEN (для nested-pass'а).
      const maiaCache = new Map<string, MaiaPolicy>();
      async function getMaiaCached(fen: string): Promise<MaiaPolicy> {
        const hit = maiaCache.get(fen);
        if (hit) return hit;
        const res = await engines.predictMaia(fen, elo);
        maiaCache.set(fen, res);
        return res;
      }

      const moveInputs: MoveInput[] = [];

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
          // Через `getSf` — кэш на тот же FEN (transpositions, ADR-101 §4).
          const sf = await getSf(fenBefore);

          // Maia policy.
          const maia = await getMaiaCached(fenBefore);

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

          // wdlAfterMaiaTop: только если maiaTop попал в SF top-3
          // (по ADR-100 §7 второго SF-вызова на каждый альтернативный
          // ход не делаем — это слишком долго). KS-3607: invertWdl
          // здесь НЕ нужен — wdlByMove от analyzeSf уже в POV ходящей
          // стороны fenBefore.
          const wdlAfterMaiaTop: Wdl | undefined = maia.topUci
            ? sf.wdlByMove[maia.topUci]
            : undefined;

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
          setProgress({ done: i + 1, total: plies.length });
        }
      } catch (e) {
        engines.terminate();
        enginesRef.current = null;
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
        return;
      }

      // KS-3610 (ADR-101 §4.1/§4.2 v2): stabilized subline через
      // `buildStabilizedLine`. Используем тот же `sfCache` — реально
      // на каждую позицию сети уже посчитаны при main-pass'е, новых
      // SF-вызовов в большинстве случаев нет. Если позиция в кэше
      // отсутствует — adapter синхронно возвращает `null` (вариант
      // обрывается на текущей длине; перерасчёт SF тут стоил бы
      // лишнего бюджета).
      const stabilizedEngines: StabilizedEngines = {
        engineGetBestLine: (fen) => {
          const cached = sfCache.get(fen);
          if (!cached) return null;
          return { bestUci: cached.bestUci, wdlAfter: cached.wdlAfterBest };
        },
        applyMoveToFen: (fen, uci) => {
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
        },
      };

      for (const input of moveInputs) {
        if (cancelRef.current) break;
        // green: stabilized от позиции после sfBest, длина cap=MAX (8).
        if (input.sfBestUci && input.sfBestUci !== input.playedUci) {
          const fenAfterBest = stabilizedEngines.applyMoveToFen(
            input.fen,
            input.sfBestUci,
          );
          if (fenAfterBest) {
            const firstMove: StabilizedFirstMove = {
              uci: input.sfBestUci,
              wdlAfter: input.wdlAfterBest,
            };
            const line = buildStabilizedLine(
              input.fen,
              firstMove,
              stabilizedEngines,
              MAX_LINE_LENGTH_PLIES,
            );
            // subline = ходы после firstMove.
            if (line.length > 1) input.sfBestSubline = line.slice(1);
          }
        }
        // red: stabilized от позиции после maiaTop, cap=SUB (4).
        if (input.wdlAfterMaiaTop && input.maiaTopUci) {
          const firstMove: StabilizedFirstMove = {
            uci: input.maiaTopUci,
            wdlAfter: input.wdlAfterMaiaTop,
          };
          const line = buildStabilizedLine(
            input.fen,
            firstMove,
            stabilizedEngines,
            SUB_VARIATION_MAX_LENGTH_PLIES,
          );
          if (line.length > 1) input.maiaTopSubline = line.slice(1);
        }
      }

      const annotations: Annotation[] = moveInputs.map(buildAnnotation);

      // KS-3610 (ADR-101 §4.0/§4.2/§5): nested-pass. На каждой main-
      // variation проходим рекурсивно и добавляем Maia-альтернативы
      // под каждым её полуходом. Лимиты §5: per-node 2, total 12 на
      // main-полуход, depth ≤ 4.
      //
      // Источник данных — sfCache (positional) + maiaCache. Если
      // позиция вне кэша (например, ход вглубь stabilized-варианта на
      // которой не запускали SF) — adapter возвращает `null` и
      // соответствующий полуход пропускается. Это и есть ADR-100 §7
      // ограничение «не делаем второго SF на каждый альтернативный
      // ход».
      const nestedEngines: NestedBuilderEngines = {
        stabilized: stabilizedEngines,
        getMaia: (fen) => {
          const m = maiaCache.get(fen);
          if (!m || !m.topUci) return null;
          return { topUci: m.topUci, topProb: m.topProb };
        },
        getWdlBefore: (fen) => sfCache.get(fen)?.wdlBefore ?? null,
        getWdlAfterMove: (fen, uci) => sfCache.get(fen)?.wdlByMove[uci] ?? null,
      };

      for (let i = 0; i < annotations.length; i++) {
        if (cancelRef.current) break;
        const ann = annotations[i];
        if (ann.variations.length === 0) continue;
        const budget = makeBudget(ann.variations.length);
        const fenAtMainMove = moveInputs[i].fen;
        for (const variation of ann.variations) {
          if (budget.remainingTotal <= 0) break;
          buildNestedVariations(
            variation,
            fenAtMainMove,
            nestedEngines,
            1,
            budget,
          );
        }
      }

      engines.terminate();
      enginesRef.current = null;

      setResult({ annotations, moveInputs });
      setStatus('done');
    },
    [elo, depth, injectedEngines],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
    if (enginesRef.current) {
      enginesRef.current.terminate();
      enginesRef.current = null;
    }
    setStatus((prev) => (prev === 'running' ? 'cancelled' : prev));
  }, []);

  const reset = useCallback(() => {
    cancelRef.current = false;
    enginesRef.current?.terminate();
    enginesRef.current = null;
    setStatus('idle');
    setError(undefined);
    setResult(undefined);
    setProgress({ done: 0, total: 0 });
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
    run,
    cancel,
    reset,
  };
}
