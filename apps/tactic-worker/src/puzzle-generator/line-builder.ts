/**
 * KS-2431. Построение форсированной линии puzzle (ADR-041 §2.4).
 *
 * После того как pipeline нашёл blunder и проверил uniqueness в
 * стартовой позиции puzzle, нужно расширить решение на 2-6 полуходов:
 *
 *   - На наших ходах: MultiPV-2, требуем spread ≥ minSpread иначе stop.
 *   - На ходах соперника: если 1 легальный ход — apply forcing.
 *     Иначе берём best ответ; если spread между всеми легальными
 *     ходами соперника < ~50cp — все защиты эквивалентно проигрывают,
 *     можно продолжать; иначе stop (соперник может выбрать «лучшую
 *     защиту», что делает линию неуникальной для нашей цели).
 *   - Stop conditions: mate, повтор, превышение maxLineLength.
 *
 * Результат — массив UCI-ходов и финальная eval. Если линия короче
 * minLineLength — caller отбраковывает puzzle.
 */
import { Chess } from 'chess.js';
import type { EngineApi } from './types';
import { cpFromSide, isMateScore } from './score';

export interface LineResult {
  /** UCI-ходы линии (включая 1-й «решающий» ход и ответы соперника). */
  moves: string[];
  /** Финальная оценка от лица решающей стороны (cp; для мата — большой +). */
  finalCpForSolver: number;
  /** True, если линия закончилась матом нашего соперника. */
  endsInMate: boolean;
  /**
   * AcceptedMoves: для полуходов соперника, где было несколько
   * эквивалентных защит (spread < threshold), записываем все
   * допустимые ответы. Формат: индекс полухода → список UCI.
   * null если на всех ответах был один-единственный ход.
   */
  acceptedMoves: Record<number, string[]> | null;
}

export interface LineBuilderOptions {
  engine: EngineApi;
  depth: number;
  multiPV: number;
  minSpread: number;
  /** Допустимый спред между лучшим и худшим ответом соперника (если меньше — все защиты «одинаково плохи»). */
  defenseSpread: number;
  maxLineLength: number;
  /** Сторона, решающая puzzle (от лица которой считаем eval). */
  solverSide: 'w' | 'b';
}

export async function buildForcedLine(
  startFen: string,
  firstMoveUci: string,
  opts: LineBuilderOptions,
): Promise<LineResult> {
  const moves: string[] = [];
  const acceptedMoves: Record<number, string[]> = {};
  const seen = new Set<string>([startFen]);

  const chess = new Chess(startFen);
  let finalCpForSolver = 0;
  let endsInMate = false;

  // Применяем первый ход решения.
  if (!applyUci(chess, firstMoveUci)) {
    return {
      moves: [],
      finalCpForSolver: 0,
      endsInMate: false,
      acceptedMoves: null,
    };
  }
  moves.push(firstMoveUci);
  seen.add(chess.fen());

  while (moves.length < opts.maxLineLength) {
    if (chess.isGameOver()) {
      endsInMate = chess.isCheckmate();
      // Финальный eval — у нас на руках; mate в нашу пользу:
      finalCpForSolver = endsInMate
        ? cpFromSide(
            { type: 'mate', value: 0 },
            opts.solverSide,
            chess.turn(),
          )
        : finalCpForSolver;
      break;
    }

    const isOpponentTurn = chess.turn() !== opts.solverSide;
    const fen = chess.fen();

    if (isOpponentTurn) {
      const legal = chess.moves({ verbose: true });
      if (legal.length === 0) {
        // Stalemate / mate уже обработан выше — здесь сюрприз, выходим.
        break;
      }
      if (legal.length === 1) {
        const uci = uciOf(legal[0]);
        if (!applyUci(chess, uci)) break;
        moves.push(uci);
        if (seen.has(chess.fen())) break;
        seen.add(chess.fen());
        continue;
      }
      // MultiPV для соперника: какие ответы дают близкий итоговый eval?
      const lines = await opts.engine.analyzeMultiPV(
        fen,
        opts.depth,
        Math.min(opts.multiPV, legal.length),
      );
      if (lines.length === 0) break;
      // Сортируем относительно соперника (он играет лучший за себя),
      // но spread считаем от его лица — берём lines as-is (Stockfish
      // отдаёт уже от стороны на ходу).
      const oppCps = lines.map((l) =>
        cpFromSide(l.score, chess.turn() as 'w' | 'b', chess.turn() as 'w' | 'b'),
      );
      const oppMax = oppCps[0];
      const oppMin = oppCps[oppCps.length - 1];
      // Если все ответы соперника близки (разброс < defenseSpread) —
      // все они эквивалентно проигрывают; принимаем best и фиксируем
      // alternates как acceptedMoves.
      const okBranch = oppMax - oppMin <= opts.defenseSpread;
      if (!okBranch) {
        // Соперник может выбрать «менее проигрышный» вариант — это
        // означает, что у нас не одно «правильное» решение в линии:
        // нужен другой наш ход после хода соперника. MVP-стоп.
        break;
      }
      const bestOpp = lines[0].bestMove;
      if (!applyUci(chess, bestOpp)) break;
      const idx = moves.length;
      moves.push(bestOpp);
      if (lines.length > 1) {
        // Все близкие альтернативы соперника — допустимы.
        const alts: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (oppCps[i] - oppMin <= opts.defenseSpread) {
            alts.push(lines[i].bestMove);
          }
        }
        if (alts.length > 1) acceptedMoves[idx] = alts;
      }
      if (seen.has(chess.fen())) break;
      seen.add(chess.fen());
      // Eval после ответа соперника — обновляем для finalCpForSolver:
      finalCpForSolver = cpFromSide(
        lines[0].score,
        opts.solverSide,
        chess.turn() as 'w' | 'b',
      );
    } else {
      // Наш ход. MultiPV ≥ 2. Spread должен быть ≥ minSpread иначе
      // линия теряет уникальность (есть второй «равно-сильный» план).
      const lines = await opts.engine.analyzeMultiPV(
        fen,
        opts.depth,
        Math.min(opts.multiPV, 2),
      );
      if (lines.length === 0) break;
      const ourSide = chess.turn() as 'w' | 'b';
      const bestCp = cpFromSide(lines[0].score, ourSide, ourSide);
      if (lines.length >= 2) {
        const secondCp = cpFromSide(lines[1].score, ourSide, ourSide);
        const spread = bestCp - secondCp;
        if (
          !isMateScore(lines[0].score) /* mate — сам по себе уникален */ &&
          spread < opts.minSpread
        ) {
          // Несколько хороших вариантов — стоп (puzzle обрывается раньше).
          break;
        }
      }
      const ourBest = lines[0].bestMove;
      if (!applyUci(chess, ourBest)) break;
      moves.push(ourBest);
      if (seen.has(chess.fen())) break;
      seen.add(chess.fen());
      finalCpForSolver = cpFromSide(
        lines[0].score,
        opts.solverSide,
        chess.turn() as 'w' | 'b',
      );
    }
  }

  if (chess.isCheckmate()) endsInMate = true;
  return {
    moves,
    finalCpForSolver,
    endsInMate,
    acceptedMoves: Object.keys(acceptedMoves).length > 0 ? acceptedMoves : null,
  };
}

function uciOf(m: { from: string; to: string; promotion?: string }): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

function applyUci(chess: Chess, uci: string): boolean {
  if (uci.length < 4) return false;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
  try {
    const res = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
    return !!res;
  } catch {
    return false;
  }
}
