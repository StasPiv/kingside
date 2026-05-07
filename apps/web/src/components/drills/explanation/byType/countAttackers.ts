/**
 * KS-2456 §5.1 + KS-2454 (chess-expert методика). Explanation для
 * `count-attackers` (и defenders-варианта KS-2452).
 *
 * Логика:
 *  - `target = drill.meta.highlightedSquare`
 *  - `attackerColor = drill.meta.attackerColor` (цвет считаемой стороны)
 *  - Если на target стоит фигура цвета `attackerColor` → это
 *    «defenders mode» (своя сторона свою же клетку защищает). Иначе —
 *    обычный attackers.
 *
 * Стрелки: одна `correct-attack` (или `defense`) от каждой считаемой
 * фигуры → клетка target. ВАЖНО: стрелка идёт В КЛЕТКУ, не в фигуру
 * на ней — это методически точно для X-ray и батарей (chess-expert
 * KS-2454).
 *
 * Подсветки: target='target', все клетки атакующих/защитников =
 * 'correct'. При shape='number' per-attacker feedback невозможен (не
 * знаем какие именно фигуры пользователь «увидел») — показываем все
 * как correct. При неверном ответе — отдельная заметка с числом
 * пользователя (но без разделения missed/wrong среди атакующих).
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

export function explainCountAttackers(input: ExplainDrillInput): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'number') return EMPTY_EXPLANATION;
  const target = drill.meta?.highlightedSquare;
  const attackerColor = drill.meta?.attackerColor;
  if (!target || !attackerColor) return EMPTY_EXPLANATION;

  let chess: Chess;
  try {
    chess = new Chess(drill.fen);
  } catch {
    return EMPTY_EXPLANATION;
  }

  const targetSq = target as Square;
  const piece = chess.get(targetSq);
  // KS-2452: своя фигура на target → defenders mode.
  const isDefendersMode = !!piece && piece.color === (attackerColor as Color);

  // chess.attackers(square, color) — все клетки фигур цвета `color`,
  // атакующих `square`. В шахматной нотации «защитник» = атакующий
  // своей фигуры на той же клетке (X-ray, прямая защита) — поэтому
  // используем тот же API.
  const sources = chess.attackers(targetSq, attackerColor as Color) as Square[];

  const arrowRole = isDefendersMode ? 'defense' : 'correct-attack';
  const arrows: DrillExplanationArrow[] = sources.map((from) => ({
    from,
    to: target,
    role: arrowRole,
  }));

  const highlights: DrillExplanationHighlight[] = [
    { square: target, role: 'target' },
    ...sources.map<DrillExplanationHighlight>((sq) => ({
      square: sq,
      role: 'correct',
    })),
  ];

  const noteNamespace = isDefendersMode
    ? 'drills.explanation.countDefenders'
    : 'drills.explanation.countAttackers';

  const correctCount = correctAnswer.value;
  const notes: DrillExplanationNote[] = [
    {
      key: `${noteNamespace}.correct`,
      params: {
        count: correctCount,
        square: target,
      },
      tone: solved ? 'success' : 'info',
    },
  ];

  if (sources.length > 0) {
    notes.push({
      key: `${noteNamespace}.list`,
      params: { pieces: formatSquareList(sources) },
      tone: 'info',
    });
  }

  if (userAnswer && userAnswer.shape === 'number' && !solved) {
    notes.unshift({
      key: `${noteNamespace}.userAnswer`,
      params: { userCount: userAnswer.value },
      tone: 'wrong',
    });
  }

  return { arrows, highlights, notes };
}
