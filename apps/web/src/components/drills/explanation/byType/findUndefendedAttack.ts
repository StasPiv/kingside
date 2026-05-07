/**
 * KS-2456 §5.6 + KS-2454. Explanation для `find-undefended-attack`.
 *
 * shape='move'. После хода `correctAnswer.from→to` появляется новая
 * атака на вражескую фигуру, у которой нет защитников.
 *
 * KS-2455: `computeNewThreatsAfterMove` из `@kingside/shared` —
 * pure-функция, возвращает массив клеток новых висящих угроз
 * (король исключён по определению).
 *
 * Стрелки:
 *  - `correct-move` от correctAnswer.from → correctAnswer.to (сам ход).
 *  - `threat-target` от correctAnswer.to → каждая новая жертва.
 *
 * Подсветки:
 *  - `target` = клетка жертвы (если несколько — все).
 *  - `correct` = correctAnswer.to (приземление атакующего).
 *  - `context` = correctAnswer.from + клетки жертв.
 *  - `wrong` = userAnswer.to при ошибке.
 *
 * Notes:
 *  - `correct` (одна жертва) или `correctMulti` (несколько) — список.
 *  - `wrong` — ошибка пользователя.
 */
import { Chess, type Square } from 'chess.js';
import { computeNewThreatsAfterMove } from '@kingside/shared';
import type {
  DrillExplanation,
  DrillExplanationArrow,
  DrillExplanationHighlight,
  DrillExplanationNote,
  ExplainDrillInput,
} from '../types';
import { EMPTY_EXPLANATION } from '../types';
import { formatSquareList } from '../helpers';

export function explainFindUndefendedAttack(
  input: ExplainDrillInput,
): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'move') return EMPTY_EXPLANATION;

  const { newThreats } = computeNewThreatsAfterMove(drill.fen, {
    from: correctAnswer.from,
    to: correctAnswer.to,
    promotion: correctAnswer.promotion,
  });

  // Пробег по `after`-доске — нужны типы жертв и существование атакующего.
  let after: Chess;
  try {
    after = new Chess(drill.fen);
    after.move({
      from: correctAnswer.from,
      to: correctAnswer.to,
      ...(correctAnswer.promotion ? { promotion: correctAnswer.promotion } : {}),
    });
  } catch {
    return EMPTY_EXPLANATION;
  }
  const attackerSq = correctAnswer.to as Square;
  if (!after.get(attackerSq)) return EMPTY_EXPLANATION;

  const arrows: DrillExplanationArrow[] = [
    {
      from: correctAnswer.from,
      to: correctAnswer.to,
      role: 'correct-move',
    },
    ...newThreats.map<DrillExplanationArrow>((sq) => ({
      from: correctAnswer.to,
      to: sq,
      role: 'threat-target',
    })),
  ];

  const highlights: DrillExplanationHighlight[] = [
    { square: correctAnswer.from, role: 'context' },
    { square: correctAnswer.to, role: 'correct' },
  ];
  for (const sq of newThreats) {
    highlights.push({ square: sq, role: 'target' });
    highlights.push({ square: sq, role: 'context' });
  }

  const notes: DrillExplanationNote[] = [];
  if (newThreats.length === 1) {
    const sq = newThreats[0];
    const victim = after.get(sq as Square);
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.correct',
      params: {
        move: `${correctAnswer.from}${correctAnswer.to}`,
        piece: victim?.type ?? '?',
        pieceKey: victim ? `chess.pieces.${victim.type}` : 'chess.pieces.unknown',
        square: sq,
      },
      tone: solved ? 'success' : 'info',
    });
  } else if (newThreats.length > 1) {
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.correctMulti',
      params: {
        move: `${correctAnswer.from}${correctAnswer.to}`,
        count: newThreats.length,
        squares: formatSquareList(newThreats),
      },
      tone: solved ? 'success' : 'info',
    });
  } else {
    // Edge: drill утверждает «есть угроза», но helper не нашёл — fallback
    // на минимальное note, чтобы не оставить пустой explanation.
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.correctMulti',
      params: {
        move: `${correctAnswer.from}${correctAnswer.to}`,
        count: 0,
        squares: '',
      },
      tone: solved ? 'success' : 'info',
    });
  }

  if (userAnswer && userAnswer.shape === 'move' && !solved) {
    const wrongTo = userAnswer.to as Square;
    if (wrongTo !== correctAnswer.to) {
      highlights.push({ square: wrongTo, role: 'wrong' });
    }
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.wrong',
      params: { from: userAnswer.from, to: userAnswer.to },
      tone: 'wrong',
    });
  }

  return { arrows, highlights, notes };
}
