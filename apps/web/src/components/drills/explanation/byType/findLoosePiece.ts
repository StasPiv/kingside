/**
 * KS-2456 §5.2 + KS-2454. Explanation для `find-loose-piece`.
 *
 * Loose-фигура: вражеская фигура без защитников (под боем не
 * обязательно). Drill требует одну клетку — `correctAnswer.shape ===
 * 'square'`.
 *
 * Стрелки: нет (loose ≠ под атакой по определению — нечего показывать
 * стрелкой). Если методика позже потребует context-стрелок защиты для
 * userAnswer.square — добавим.
 *
 * Подсветки:
 *  - `correct` — клетка с loose-фигурой (всегда).
 *  - `target` — то же что correct (для консистентности с UI слоем).
 *  - `wrong` — клетка ответа пользователя при ошибке.
 *  - `context` — клетки защитников ошибочно выбранной фигуры (показать
 *    почему она НЕ loose).
 *
 * Notes:
 *  - `findLoosePiece.correct` всегда.
 *  - `findLoosePiece.wrong` (с защитниками) — если пользователь ошибся
 *    и его фигура реально защищена.
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
import { formatSquareList } from '../helpers';

export function explainFindLoosePiece(input: ExplainDrillInput): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'square') return EMPTY_EXPLANATION;

  let chess: Chess;
  try {
    chess = new Chess(drill.fen);
  } catch {
    return EMPTY_EXPLANATION;
  }

  const correctSq = correctAnswer.square as Square;
  const correctPiece = chess.get(correctSq);
  if (!correctPiece) return EMPTY_EXPLANATION;

  const arrows: DrillExplanationArrow[] = [];
  const highlights: DrillExplanationHighlight[] = [
    { square: correctSq, role: 'target' },
    { square: correctSq, role: 'correct' },
  ];

  const notes: DrillExplanationNote[] = [
    {
      key: 'drills.explanation.findLoosePiece.correct',
      params: {
        piece: correctPiece.type,
        pieceKey: `chess.pieces.${correctPiece.type}`,
        square: correctSq,
      },
      tone: solved ? 'success' : 'info',
    },
  ];

  if (userAnswer && userAnswer.shape === 'square' && !solved) {
    const wrongSq = userAnswer.square as Square;
    const wrongPiece = chess.get(wrongSq);
    if (wrongPiece) {
      highlights.push({ square: wrongSq, role: 'wrong' });
      // Защитники ошибочно выбранной фигуры — клетки своих, атакующих
      // wrongSq. Если их 0, фигура реально без защитников, но не та.
      const defenders = chess.attackers(
        wrongSq,
        wrongPiece.color as Color,
      ) as Square[];
      if (defenders.length > 0) {
        for (const d of defenders) {
          highlights.push({ square: d, role: 'context' });
        }
        notes.push({
          key: 'drills.explanation.findLoosePiece.wrong',
          params: {
            square: wrongSq,
            defenders: formatSquareList(defenders),
          },
          tone: 'wrong',
        });
      }
    } else {
      // Пустая клетка — необычный wrong (промах мимо фигур).
      highlights.push({ square: wrongSq, role: 'wrong' });
    }
  }

  return { arrows, highlights, notes };
}
