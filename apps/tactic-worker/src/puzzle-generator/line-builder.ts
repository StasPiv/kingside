/**
 * KS-2431 (WDL pivot). Построение линии решения.
 *
 *   - На наших ходах (= решающей стороны) — analyzePositionWdl
 *     с MultiPV=2. PV1 уникален и принимается, если:
 *       * spread WDL (PV1 - PV2) ≥ continueSpreadDelta, ИЛИ
 *       * PV1 — мат, PV2 не мат за нас (PV1 явно лучше), ИЛИ
 *       * оба мата за нас, но PV1 короче PV2 (более быстрый мат).
 *     Иначе — обрыв.
 *   - На ходах соперника — analyzePositionWdl с MultiPV=1, берём
 *     PV1 как лучший ответ без проверок.
 *   - Стоп: чекмат / стейлмейт / нет легальных ходов / engine error /
 *     PV1 не легален.
 *   - maxLineLength используется только как страховка от бесконечности
 *     (например 50 полу-ходов).
 *
 * Возвращаем UCI-ходы линии и финальный WDL_signed от лица решающей.
 */
import { Chess } from 'chess.js';
import type { EngineApi, AnalysisLimit, MultiPvLine } from './types';
import { wdlSignedFromInfo } from './score';

export interface LineResult {
  moves: string[];
  finalWdlForSolver: number;
  endsInMate: boolean;
}

export interface LineBuilderOptions {
  engine: EngineApi;
  limit: AnalysisLimit;
  /** Спред на наших последующих ходах (Y2). Если не задан — без проверки. */
  continueSpreadDelta: number;
  /** Жёсткая страховка от бесконечности (большое число, например 50). */
  maxLineLength: number;
  solverSide: 'w' | 'b';
  label?: string;
}

/**
 * Уникален ли PV1 на нашем ходу. true = можно идти дальше.
 *
 * Правила:
 *   1. PV2 отсутствует (= единственный легальный ход) → unique=true.
 *   2. PV1 — mate за нас:
 *      - PV2 не мат за нас (cp / mate против) → unique=true (мат всегда
 *        лучше «не мата»).
 *      - PV2 мат за нас, |N1| < |N2| → unique=true (более короткий мат).
 *      - PV2 мат за нас, |N1| ≥ |N2| → unique=false (одинаково быстрых
 *        матов несколько, нет уникального правильного хода).
 *   3. PV1 cp:
 *      - PV2 — mate за нас → unique=false (теоретически невозможно
 *        при правильной сортировке SF, но для надёжности).
 *      - Иначе считаем spread WDL (PV1 - PV2). unique = spread ≥ Y2.
 */
function isUniqueOnOurTurn(
  pvs: MultiPvLine[],
  solverSide: 'w' | 'b',
  spreadDelta: number,
): { unique: boolean; reason: string } {
  if (pvs.length < 2) return { unique: true, reason: 'single legal move' };
  const p1 = pvs[0];
  const p2 = pvs[1];
  const p1IsMateForUs = p1.score.type === 'mate' && p1.score.value > 0;
  const p2IsMateForUs = p2.score.type === 'mate' && p2.score.value > 0;
  if (p1IsMateForUs) {
    if (!p2IsMateForUs) return { unique: true, reason: 'mate vs non-mate' };
    // оба мата за нас — сравниваем длину
    if (p1.score.value < p2.score.value) {
      return { unique: true, reason: `mate-${p1.score.value} vs mate-${p2.score.value}` };
    }
    return { unique: false, reason: `equal-fastest mates (mate-${p1.score.value})` };
  }
  if (p2IsMateForUs) {
    return { unique: false, reason: 'PV2 mate за нас при PV1 cp' };
  }
  // оба cp (или их вариации без мата за нас) — считаем WDL spread
  const wdl1 = wdlSignedFromInfo(p1.wdl, p1.score);
  const wdl2 = wdlSignedFromInfo(p2.wdl, p2.score);
  if (wdl1 == null || wdl2 == null) {
    return { unique: false, reason: 'no WDL data' };
  }
  const spread = wdl1 - wdl2;
  return {
    unique: spread >= spreadDelta,
    reason: `spread=${spread.toFixed(3)} (Y2=${spreadDelta})`,
  };
}

export async function buildForcedLine(
  startFen: string,
  firstMoveUci: string,
  opts: LineBuilderOptions,
): Promise<LineResult> {
  const moves: string[] = [];
  // Защита от повторения позиции (вечный шах, retro-loop). Ключ —
  // только расстановка фигур + сторона на ходу (без счётчиков ходов),
  // потому что эти поля не влияют на «ту же позицию».
  function fenKey(c: Chess): string {
    return c.fen().split(' ').slice(0, 4).join(' ');
  }
  const chess = new Chess(startFen);
  const seen = new Set<string>([fenKey(chess)]);
  let finalWdlForSolver = 0;
  let endsInMate = false;

  // Первый ход уже выбран pipeline'ом (PV1 после зевка).
  if (!applyUci(chess, firstMoveUci)) {
    return { moves: [], finalWdlForSolver: 0, endsInMate: false };
  }
  moves.push(firstMoveUci);
  seen.add(fenKey(chess));

  while (moves.length < opts.maxLineLength) {
    if (chess.isGameOver()) {
      endsInMate = chess.isCheckmate();
      if (endsInMate) {
        const losingSide = chess.turn() as 'w' | 'b';
        finalWdlForSolver = losingSide === opts.solverSide ? -1 : 1;
      }
      break;
    }
    const isOpponentTurn = chess.turn() !== opts.solverSide;
    const fen = chess.fen();

    if (isOpponentTurn) {
      let pvs;
      try {
        pvs = await opts.engine.analyzePositionWdl(fen, opts.limit, 1, opts.label);
      } catch {
        break;
      }
      if (pvs.length === 0) break;
      const oppMove = pvs[0].bestMove;
      if (!applyUci(chess, oppMove)) break;
      const keyAfter = fenKey(chess);
      if (seen.has(keyAfter)) {
        // Повтор позиции — откатываем ход, в линию не записываем.
        chess.undo();
        break;
      }
      seen.add(keyAfter);
      moves.push(oppMove);
      const oppPovWdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
      if (oppPovWdl != null) finalWdlForSolver = -oppPovWdl;
    } else {
      let pvs;
      try {
        pvs = await opts.engine.analyzePositionWdl(fen, opts.limit, 2, opts.label);
      } catch {
        break;
      }
      if (pvs.length === 0) break;
      // KS-2431: сортируем по WDL_signed DESC, чтобы не доверять
      // multipv-индексу SF на ограниченных ресурсах.
      pvs = [...pvs].sort((a, b) => {
        const wa = wdlSignedFromInfo(a.wdl, a.score);
        const wb = wdlSignedFromInfo(b.wdl, b.score);
        if (wa == null && wb == null) return 0;
        if (wa == null) return 1;
        if (wb == null) return -1;
        return wb - wa;
      });
      const { unique } = isUniqueOnOurTurn(pvs, opts.solverSide, opts.continueSpreadDelta);
      if (!unique) break;
      const ourPovWdl = wdlSignedFromInfo(pvs[0].wdl, pvs[0].score);
      if (ourPovWdl != null) finalWdlForSolver = ourPovWdl;
      const ourMove = pvs[0].bestMove;
      if (!applyUci(chess, ourMove)) break;
      const keyAfter = fenKey(chess);
      if (seen.has(keyAfter)) {
        chess.undo();
        break;
      }
      seen.add(keyAfter);
      moves.push(ourMove);
    }
  }

  if (chess.isCheckmate()) endsInMate = true;
  // Постпроцессинг: пазл должен заканчиваться нашим ходом. Если
  // последний полу-ход — соперника (чётная длина), отрезаем его.
  if (moves.length > 0 && moves.length % 2 === 0) {
    moves.pop();
  }
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
