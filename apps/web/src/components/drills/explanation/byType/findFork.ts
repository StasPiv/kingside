/**
 * KS-2456 §5.5 + KS-2454. Explanation для `find-fork`.
 *
 * KS-2400: shape='move'. correctAnswer.from / .to — ход, создающий
 * вилку. Forking-фигура после хода стоит на correctAnswer.to.
 *
 * KS-2455: `computeForkTargetsAfterMove` из `@kingside/shared` —
 * pure-функция, возвращает clean fork: forkerSq + ≥2 targets (ценные
 * фигуры, включая короля; пешки исключены порогом VALUABLE_THRESHOLD).
 *
 * Король среди targets обрабатывается отдельно (методика KS-2454: fork
 * с шахом — отдельная формулировка «forks the king and …»).
 *
 * Стрелки:
 *  - `correct-attack` от forker → каждая жертва (≥2).
 *  - `correct-move` от correctAnswer.from → correctAnswer.to (показать
 *    сам ход — он часть «вилки», не только результат).
 *
 * Подсветки:
 *  - `target` = correctAnswer.to (forker landing).
 *  - `correct` = correctAnswer.to.
 *  - `context` = жертвы вилки + correctAnswer.from.
 *  - `wrong` = userAnswer.to при ошибке.
 *
 * Notes:
 *  - `correctWithCheck` если в жертвах король.
 *  - `correct` иначе — список жертв.
 *  - `wrong` — ошибка пользователя.
 */
import { Chess, type Square } from 'chess.js';
import { computeForkTargetsAfterMove } from '@kingside/shared';
import type {
  DrillExplanation,
  DrillExplanationArrow,
  DrillExplanationHighlight,
  DrillExplanationNote,
  ExplainDrillInput,
} from '../types';
import { EMPTY_EXPLANATION } from '../types';
import { formatSquareList } from '../helpers';

export function explainFindFork(input: ExplainDrillInput): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'move') return EMPTY_EXPLANATION;

  const fork = computeForkTargetsAfterMove(drill.fen, {
    from: correctAnswer.from,
    to: correctAnswer.to,
    promotion: correctAnswer.promotion,
  });
  if (!fork) return EMPTY_EXPLANATION;

  // Применяем тот же ход локально — нужен `after`-Chess для определения
  // типов фигур (король среди targets, тип форкера).
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
  const forker = after.get(fork.forkerSq as Square);
  if (!forker) return EMPTY_EXPLANATION;

  let kingSq: string | null = null;
  const nonKingTargets: string[] = [];
  for (const t of fork.targets) {
    const p = after.get(t as Square);
    if (p?.type === 'k') kingSq = t;
    else nonKingTargets.push(t);
  }

  const arrows: DrillExplanationArrow[] = [
    {
      from: correctAnswer.from,
      to: correctAnswer.to,
      role: 'correct-move',
    },
    ...fork.targets.map<DrillExplanationArrow>((tg) => ({
      from: fork.forkerSq,
      to: tg,
      role: 'correct-attack',
    })),
  ];

  const highlights: DrillExplanationHighlight[] = [
    { square: correctAnswer.to, role: 'target' },
    { square: correctAnswer.to, role: 'correct' },
    { square: correctAnswer.from, role: 'context' },
    ...fork.targets.map<DrillExplanationHighlight>((tg) => ({
      square: tg,
      role: 'context',
    })),
  ];

  const notes: DrillExplanationNote[] = [];
  if (kingSq) {
    notes.push({
      key: 'drills.explanation.findFork.correctWithCheck',
      params: {
        piece: forker.type,
        pieceKey: `chess.pieces.${forker.type}`,
        move: `${correctAnswer.from}${correctAnswer.to}`,
        king: kingSq,
        targets: formatSquareList(nonKingTargets),
      },
      tone: solved ? 'success' : 'info',
    });
  } else {
    notes.push({
      key: 'drills.explanation.findFork.correct',
      params: {
        piece: forker.type,
        pieceKey: `chess.pieces.${forker.type}`,
        move: `${correctAnswer.from}${correctAnswer.to}`,
        targets: formatSquareList(nonKingTargets),
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
      key: 'drills.explanation.findFork.wrong',
      params: { from: userAnswer.from, to: userAnswer.to },
      tone: 'wrong',
    });
  }

  return { arrows, highlights, notes };
}
