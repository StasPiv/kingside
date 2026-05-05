/**
 * KS-2431 (WDL pivot). Построение линии решения с проверкой
 * spread WDL на каждом нашем ходу.
 *
 *   - На каждом нашем ходу (= решающей стороны) — analyzePositionWdl
 *     с MultiPV=2. Принимаем ход если ΔWDL_спред ≥ spreadDelta или
 *     если PV2 отсутствует (легальный ход один).
 *   - На ходах соперника — analyzePositionWdl с MultiPV=1, берём
 *     PV1 как лучший ответ.
 *   - Стоп: достигнута maxLineLength, mate, повтор позиции,
 *     нарушен spread, нет легальных ходов.
 *
 * Возвращаем UCI-ходы линии и финальный WDL_signed от лица решающей.
 */
import { Chess } from 'chess.js';
import type { EngineApi, AnalysisLimit } from './types';
import { wdlSignedFromInfo } from './score';

export interface LineResult {
  /** UCI-ходы (включая первый ход решения). */
  moves: string[];
  /** WDL от лица решающей в финальной позиции (после последнего хода). */
  finalWdlForSolver: number;
  /** Закончилась матом? */
  endsInMate: boolean;
}

export interface LineBuilderOptions {
  engine: EngineApi;
  limit: AnalysisLimit;
  spreadDelta: number;
  maxLineLength: number;
  /** Сторона, решающая puzzle. */
  solverSide: 'w' | 'b';
}

export async function buildForcedLine(
  startFen: string,
  firstMoveUci: string,
  opts: LineBuilderOptions,
): Promise<LineResult> {
  const moves: string[] = [];
  const seen = new Set<string>([startFen]);
  const chess = new Chess(startFen);
  let finalWdlForSolver = 0;
  let endsInMate = false;

  // Первый ход решения уже выбран pipeline'ом (PV1 после зевка).
  if (!applyUci(chess, firstMoveUci)) {
    return { moves: [], finalWdlForSolver: 0, endsInMate: false };
  }
  moves.push(firstMoveUci);
  seen.add(chess.fen());

  while (moves.length < opts.maxLineLength) {
    if (chess.isGameOver()) {
      endsInMate = chess.isCheckmate();
      // Финальный WDL: если мат — победа решающей (+1), иначе оставляем
      // что было.
      if (endsInMate) {
        // Чей ход был перед матом? Тот, кому теперь некуда ходить —
        // это сторона, получившая мат. Если это противник solverSide,
        // решающий выиграл.
        const losingSide = chess.turn() as 'w' | 'b';
        finalWdlForSolver = losingSide === opts.solverSide ? -1 : 1;
      }
      break;
    }
    const isOpponentTurn = chess.turn() !== opts.solverSide;
    const fen = chess.fen();

    if (isOpponentTurn) {
      // Лучший ход соперника, без проверки spread (как cook_advantage).
      let pvs;
      try {
        pvs = await opts.engine.analyzePositionWdl(fen, opts.limit, 1);
      } catch {
        break;
      }
      if (pvs.length === 0) break;
      const oppMove = pvs[0].bestMove;
      if (!applyUci(chess, oppMove)) break;
      moves.push(oppMove);
      const fenAfter = chess.fen();
      if (seen.has(fenAfter)) break;
      seen.add(fenAfter);
      // Обновляем finalWdlForSolver: WDL от лица solverSide теперь.
      // pvs[0].wdl от лица side-to-move = противник solverSide.
      // Инверсия: -wdlSignedFromInfo.
      const oppPovWdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
      if (oppPovWdl != null) finalWdlForSolver = -oppPovWdl;
    } else {
      // Наш ход. Требуем ΔWDL_спред ≥ Y.
      let pvs;
      try {
        pvs = await opts.engine.analyzePositionWdl(fen, opts.limit, 2);
      } catch {
        break;
      }
      if (pvs.length === 0) break;
      const ourPovWdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
      if (ourPovWdl == null) break; // нет шансов оценить
      finalWdlForSolver = ourPovWdl;
      // Spread проверяется только если PV2 есть.
      if (pvs.length >= 2) {
        const secondWdl = wdlSignedFromInfo(pvs[1].wdl, pvs[1].score);
        if (secondWdl != null) {
          const spread = ourPovWdl - secondWdl;
          if (spread < opts.spreadDelta) break;
        }
      }
      const ourMove = pvs[0].bestMove;
      if (!applyUci(chess, ourMove)) break;
      moves.push(ourMove);
      const fenAfter = chess.fen();
      if (seen.has(fenAfter)) break;
      seen.add(fenAfter);
    }
  }

  if (chess.isCheckmate()) endsInMate = true;
  return { moves, finalWdlForSolver, endsInMate };
}

function applyUci(chess: Chess, uci: string): boolean {
  if (uci.length < 4) return false;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
  try {
    const r = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
    return !!r;
  } catch {
    return false;
  }
}
