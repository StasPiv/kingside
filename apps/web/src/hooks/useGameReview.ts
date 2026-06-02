/**
 * KS-3603 (ADR-100 §3-§4, §9 этап B). Hook «Разобрать партию»: проходит
 * по всем полуходам, считает SF+Maia метрики, прогоняет
 * `buildAnnotation` и собирает `Annotation[]`.
 *
 * Архитектурное решение по сложности: оркестрация SF (через прямой
 * Stockfish Worker) и Maia (через `MaiaWorkerEngine.predictMoves`)
 * **последовательная** по полуходам в main thread. По §7 ADR-100 на
 * партии ~80 полуходов это даёт ≤ 40с p95 — приемлемо для MVP.
 * Worker-оркестратор (отдельный thread с двумя engine'ами внутри)
 * вынесен в опциональную фабрику `engines` — это и про DI для тестов,
 * и про будущую возможность вынести в Worker без перетряхивания API.
 *
 * Cancel: `terminate()` обоих engine'ов; state.status → 'cancelled'.
 */
import { useCallback, useRef, useState } from 'react';
import { Chess } from 'chess.js';

import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import {
  buildAnnotation,
  mateToCp,
  type Annotation,
  type MoveInput,
} from '../lib/review/buildAnnotations';

// --- engine-провайдеры (DI) ------------------------------------------------

/**
 * Результат SF-анализа позиции (multipv=N, depth=D).
 */
export interface SfPositionResult {
  /** UCI top-1 (sfBestUci). */
  bestUci: string;
  /** Eval позиции (с т. зр. side-to-move) первой линии. mate → ±10000-N. */
  bestCp: number;
  /** Eval second-best (multipv=2) — для критерия !!. */
  secondCp: number;
  /** PV первой линии Stockfish (UCI'ы). */
  bestPv: string[];
  /** Mate-in-N если top-1 ведёт к мату. */
  mateBefore: number | null;
  /** Кол-во легальных ходов в позиции — для forcedMove критерия. */
  legalMovesCount: number;
}

export interface SfEvalAfterResult {
  /** Eval позиции после хода (с т. зр. side-to-move новой стороны).
   *  Caller должен инвертировать, чтобы привести к т. зр. ходящей. */
  cp: number;
}

export interface MaiaPolicy {
  byUci: Record<string, number>;
  topUci: string;
  topProb: number;
}

export interface ReviewEngines {
  /** SF анализ позиции `fen` с multipv=N (нужно ≥2). */
  analyzeSf(fen: string, multipv: number, depth: number): Promise<SfPositionResult>;
  /** SF быстрый eval позиции (multipv=1) — для cpPlayed. */
  evalAfter(fen: string, depth: number): Promise<SfEvalAfterResult>;
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
  /**
   * ELO Maia для прогона (см. SettingsPage / `analysis.maia.elo`).
   * Дефолт 1500.
   */
  elo?: number;
  /** SF depth. ADR-100 §7: 18 default. */
  depth?: number;
  /**
   * Кастомный engines-провайдер — для тестов. По умолчанию —
   * `createDefaultEngines()`, которая создаёт SF/Maia Worker'ы.
   */
  engines?: ReviewEngines;
}

export interface ReviewResult {
  annotations: Annotation[];
  /** Финальный массив `MoveInput` — пригодится для отладки. */
  moveInputs: MoveInput[];
}

// --- helpers ---------------------------------------------------------------

interface ParsedGameMove {
  ply: number;
  fenBefore: string;
  playedUci: string;
}

/**
 * Парсит PGN/SAN в массив полуходов с FEN перед каждым.
 */
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
      /* ignore — стартовая */
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

/** §3.1 last bullet: forced move = либо 1 легальный ход, либо все
 *  non-best с cpLoss ≥ 300. Здесь параметр caller-side — мы можем
 *  только проверить «1 легальный ход» (cpLoss требует доп. вызовов
 *  SF на каждый альтернативный ход — слишком дорого для MVP). */
function isForcedMove(legalMovesCount: number): boolean {
  return legalMovesCount <= 1;
}

// --- default engines (real Stockfish + Maia) -------------------------------

/**
 * KS-3603. Реальная реализация SF + Maia через прямые Worker'ы. Stockfish
 * stub'ы тут — но реальная UCI-обвязка делается через прямой `new Worker(
 * '/stockfish/stockfish-18-lite.js')`. Чтобы не дублировать с
 * `useStockfish` (там много reconnect-логики), используем минимальную
 * UCI-сессию с queue команд.
 *
 * Для удобства тестирования вынесено в фабрику; реальная реализация —
 * `createDefaultEngines`.
 */
export function createDefaultEngines(): ReviewEngines {
  let sfWorker: Worker | null = null;
  let pendingResolve:
    | ((lines: Array<{ multipv: number; cp: number; mateIn: number | null; pv: string[] }>) => void)
    | null = null;
  let pendingBuf: Array<{ multipv: number; cp: number; mateIn: number | null; pv: string[] }> =
    [];
  let pendingExpectedMpv = 1;

  function initSf(): Worker {
    if (sfWorker) return sfWorker;
    const w = new Worker('/stockfish/stockfish-18-lite.js');
    w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      if (line === 'uciok') {
        w.postMessage('isready');
        return;
      }
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
    };
    w.postMessage('uci');
    sfWorker = w;
    return w;
  }

  function parseInfo(line: string) {
    const depthM = line.match(/\bdepth (\d+)/);
    const mpvM = line.match(/\bmultipv (\d+)/);
    const cpM = line.match(/\bscore cp (-?\d+)/);
    const mateM = line.match(/\bscore mate (-?\d+)/);
    const pvM = line.match(/\bpv (.+)/);
    if (!depthM || !pvM) return null;
    return {
      multipv: Number(mpvM?.[1] ?? 1),
      cp: cpM ? Number(cpM[1]) : 0,
      mateIn: mateM ? Number(mateM[1]) : null,
      pv: pvM[1].split(' '),
    };
  }

  function runGo(
    fen: string,
    multipv: number,
    depth: number,
  ): Promise<
    Array<{ multipv: number; cp: number; mateIn: number | null; pv: string[] }>
  > {
    const w = initSf();
    return new Promise((resolve) => {
      pendingResolve = resolve;
      pendingBuf = [];
      pendingExpectedMpv = multipv;
      w.postMessage('ucinewgame');
      w.postMessage(`setoption name MultiPV value ${multipv}`);
      w.postMessage(`position fen ${fen}`);
      w.postMessage(`go depth ${depth}`);
    });
  }

  function lineToCp(d: { cp: number; mateIn: number | null }): number {
    return d.mateIn != null ? mateToCp(d.mateIn) : d.cp;
  }

  let maiaEngine: MaiaWorkerEngine | null = null;
  function initMaia(): MaiaWorkerEngine {
    if (!maiaEngine) maiaEngine = new MaiaWorkerEngine();
    return maiaEngine;
  }

  return {
    async analyzeSf(fen, multipv, depth) {
      const lines = await runGo(fen, multipv, depth);
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
      return {
        bestUci: top?.pv[0] ?? '',
        bestCp: top ? lineToCp(top) : 0,
        secondCp: second ? lineToCp(second) : top ? lineToCp(top) : 0,
        bestPv: top?.pv ?? [],
        mateBefore: top?.mateIn ?? null,
        legalMovesCount: legalMoves,
      };
    },
    async evalAfter(fen, depth) {
      const lines = await runGo(fen, 1, depth);
      const top = lines[0];
      return { cp: top ? lineToCp(top) : 0 };
    },
    async predictMaia(fen, elo) {
      const eng = initMaia();
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

          // SF analyze позиции перед ходом.
          const sf = await engines.analyzeSf(fenBefore, 3, depth);

          // Maia policy.
          const maia = await engines.predictMaia(fenBefore, elo);

          // SF eval после сыгранного хода (skip если played=best).
          let cpPlayed = sf.bestCp;
          if (playedUci !== sf.bestUci) {
            const post = new Chess();
            try {
              post.load(fenBefore);
              const m = post.move({
                from: playedUci.slice(0, 2),
                to: playedUci.slice(2, 4),
                promotion: playedUci.length > 4 ? playedUci[4] : undefined,
              });
              if (m) {
                const after = await engines.evalAfter(post.fen(), depth);
                // SF eval после хода — с т.зр. новой stm; инвертируем
                // обратно к перспективе ходящей стороны.
                cpPlayed = -after.cp;
              }
            } catch {
              /* нелегальный — оставляем bestCp как placeholder */
            }
          }

          // Maia top cpLoss — отдельной задачей SF не считаем (по
          // комментарию ADR §4.2 этот шаг опциональный); если maiaTop
          // присутствует в multipv=3 SF — используем его eval.
          let maiaTopCpLoss = -1;
          if (maia.topUci) {
            // smart shortcut: если maiaTop = sfBest → loss=0
            if (maia.topUci === sf.bestUci) maiaTopCpLoss = 0;
            else {
              // ищем maiaTop в sfBestPv multipv? у нас нет multipv-результатов
              // в SfPositionResult — для MVP пропускаем (red-variation не
              // сработает для этого хода). Не критично — это «trap-фишка».
            }
          }

          const input: MoveInput = {
            ply,
            fen: fenBefore,
            playedUci,
            sfBestUci: sf.bestUci,
            cpBefore: sf.bestCp,
            cpBest: sf.bestCp,
            cpPlayed,
            secondBestCp: sf.secondCp,
            sfBestPv: sf.bestPv,
            playedProb: maia.byUci[playedUci],
            sfBestProb: maia.byUci[sf.bestUci],
            maiaTopUci: maia.topUci,
            maiaTopProb: maia.topProb,
            maiaTopCpLoss,
            forcedMove: isForcedMove(sf.legalMovesCount),
            mateBefore: sf.mateBefore,
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

      engines.terminate();
      enginesRef.current = null;

      const annotations: Annotation[] = moveInputs.map(buildAnnotation);
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
