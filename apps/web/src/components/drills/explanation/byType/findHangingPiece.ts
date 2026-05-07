/**
 * KS-2456 §5.4 + KS-2454. Explanation для `find-hanging-piece`.
 *
 * KS-2335: drill требует ход (`shape='move'`) — взять зависшую фигуру
 * одним ходом. correctAnswer.from / .to. Hanging-фигура стоит на
 * `correctAnswer.to`.
 *
 * Hanging = атакована И не защищена ИЛИ защитников меньше чем атакующих
 * (chess-expert KS-2454). UI показывает стрелки `correct-attack` от
 * атакующих → клетка hanging-фигуры; если есть защитники — стрелки
 * `defense` от защитников → та же клетка (для визуального сравнения
 * дисбаланса).
 *
 * Подсветки: target = клетка hanging (correctAnswer.to). correct =
 * та же клетка. context = correctAnswer.from (стартовая клетка
 * правильного хода). wrong = userAnswer.to при ошибке.
 *
 * Notes:
 *  - `correctUndefended` (без защитников) или `correct` (есть защитники
 *    но меньше атакующих).
 *  - `wrong` — если userAnswer.to ≠ correct.to.
 */
import { Chess, type Color, type Square } from 'chess.js';
import type {
  DrillExplanation,
  DrillExplanationArrow,
  DrillExplanationHighlight,
  DrillExplanationNote,
  ExplainDrillInput,
} from '../types';
import { EMPTY_EXPLANATION } from '../types';
import { formatSquareList, moveToSan, oppColor } from '../helpers';

export function explainFindHangingPiece(input: ExplainDrillInput): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'move') return EMPTY_EXPLANATION;

  let chess: Chess;
  try {
    chess = new Chess(drill.fen);
  } catch {
    return EMPTY_EXPLANATION;
  }

  const targetSq = correctAnswer.to as Square;
  const targetPiece = chess.get(targetSq);
  if (!targetPiece) return EMPTY_EXPLANATION;
  const enemyColor = targetPiece.color as Color;
  const ourColor = oppColor(enemyColor);

  const attackers = chess.attackers(targetSq, ourColor) as Square[];
  const defenders = chess.attackers(targetSq, enemyColor) as Square[];

  const arrows: DrillExplanationArrow[] = [];
  for (const a of attackers) {
    arrows.push({ from: a, to: targetSq, role: 'correct-attack' });
  }
  for (const d of defenders) {
    arrows.push({ from: d, to: targetSq, role: 'defense' });
  }

  const highlights: DrillExplanationHighlight[] = [
    { square: targetSq, role: 'target' },
    { square: targetSq, role: 'correct' },
    { square: correctAnswer.from, role: 'context' },
  ];
  for (const a of attackers) {
    highlights.push({ square: a, role: 'context' });
  }
  for (const d of defenders) {
    highlights.push({ square: d, role: 'context' });
  }

  const notes: DrillExplanationNote[] = [];
  if (defenders.length === 0) {
    notes.push({
      key: 'drills.explanation.findHangingPiece.correctUndefended',
      params: {
        piece: targetPiece.type,
        pieceKey: `chess.pieces.${targetPiece.type}`,
        square: targetSq,
        attackers: formatSquareList(attackers),
      },
      tone: solved ? 'success' : 'info',
    });
  } else {
    notes.push({
      key: 'drills.explanation.findHangingPiece.correct',
      params: {
        piece: targetPiece.type,
        pieceKey: `chess.pieces.${targetPiece.type}`,
        square: targetSq,
        attackers: formatSquareList(attackers),
        defenders: formatSquareList(defenders),
      },
      tone: solved ? 'success' : 'info',
    });
  }

  if (userAnswer && userAnswer.shape === 'move' && !solved) {
    const wrongTo = userAnswer.to as Square;
    if (wrongTo !== targetSq) {
      highlights.push({ square: wrongTo, role: 'wrong' });
    }
    // KS-2482: ход в SAN-нотации (Bxa6, Nxe4, ...).
    const wrongSan = moveToSan(
      drill.fen,
      userAnswer.from,
      userAnswer.to,
      userAnswer.promotion,
    );
    notes.push({
      key: 'drills.explanation.findHangingPiece.wrong',
      params: { san: wrongSan },
      tone: 'wrong',
    });
  }

  return { arrows, highlights, notes };
}
