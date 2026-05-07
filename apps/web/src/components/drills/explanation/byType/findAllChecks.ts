/**
 * KS-2456 §5.7 + KS-2454. Explanation для `find-all-checks`.
 *
 * shape='squares': `correctAnswer.squares` — to-клетки всех шахующих
 * ходов. Полный список ходов (`{from, to}[]`) — `drill.meta.expectedMoves`
 * (KS-2397). Без него фронт не сможет нарисовать стрелки от правильных
 * стартовых клеток (только to). Если meta.expectedMoves отсутствует —
 * рисуем только highlights без arrows.
 *
 * Стрелки:
 *  - `correct-move` от from → to для каждого правильного хода,
 *    выбранного пользователем (или для всех, если solved).
 *  - `missed-attack` от from → to для правильных ходов, не выбранных
 *    пользователем.
 *  - Wrong-стрелки не рисуем — у пользователя в shape='squares' нет
 *    from-клетки. Wrong-клетки попадают в highlights как `wrong`.
 *
 * Подсветки:
 *  - `target` — клетка короля противника (его клетка вычисляется по FEN).
 *  - `correct` — все правильные to.
 *  - `missed` — correct ∩ ¬userAnswer.
 *  - `wrong` — userAnswer ∖ correct.
 *
 * Notes:
 *  - `correct` — count и список ходов (UCI from-to).
 *  - `missed` — если есть пропущенные.
 *  - `wrong` — если есть лишние.
 *  - `tagDiscovered` / `tagDouble` — отдельные notes на каждый
 *    discovered/double-check (методика KS-2454: пользователь должен
 *    учиться отличать механику).
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
import { formatSquareList, iterAllSquares, oppColor } from '../helpers';

interface MoveTag {
  from: string;
  to: string;
  /** 'direct' | 'discovered' | 'double' — механика шаха. */
  kind: 'direct' | 'discovered' | 'double';
}

function findKingSquare(chess: Chess, color: Color): Square | null {
  for (const sq of iterAllSquares()) {
    const p = chess.get(sq);
    if (p && p.type === 'k' && p.color === color) return sq;
  }
  return null;
}

/** Применить ход в копии и вернуть тег. null — ход нелегален. */
function tagCheckMove(
  fen: string,
  from: Square,
  to: Square,
  moverColor: Color,
): MoveTag | null {
  let probe: Chess;
  try {
    probe = new Chess(fen);
    probe.move({ from, to });
  } catch {
    return null;
  }
  if (!probe.isCheck()) return null;
  const enemyKing = findKingSquare(probe, oppColor(moverColor));
  if (!enemyKing) return null;
  const attackersOnKing = probe.attackers(enemyKing, moverColor) as Square[];
  if (attackersOnKing.length >= 2) {
    return { from, to, kind: 'double' };
  }
  // Если единственный атакующий — это та фигура, которая ходила (стоит
  // на `to`), это direct check. Иначе шахует другая фигура → discovered.
  if (attackersOnKing.length === 1 && attackersOnKing[0] === to) {
    return { from, to, kind: 'direct' };
  }
  return { from, to, kind: 'discovered' };
}

export function explainFindAllChecks(input: ExplainDrillInput): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'squares') return EMPTY_EXPLANATION;

  let chess: Chess;
  try {
    chess = new Chess(drill.fen);
  } catch {
    return EMPTY_EXPLANATION;
  }

  const moverColor = chess.turn() as Color;
  const enemyKing = findKingSquare(chess, oppColor(moverColor));
  const expectedMoves = drill.meta?.expectedMoves ?? [];

  const correctSquaresSet = new Set(correctAnswer.squares);
  const userSquaresSet = new Set<string>(
    userAnswer && userAnswer.shape === 'squares' ? userAnswer.squares : [],
  );

  const tags: MoveTag[] = [];
  for (const m of expectedMoves) {
    const tag = tagCheckMove(
      drill.fen,
      m.from as Square,
      m.to as Square,
      moverColor,
    );
    if (tag) tags.push(tag);
  }

  const arrows: DrillExplanationArrow[] = [];
  for (const m of expectedMoves) {
    const userPicked = userSquaresSet.has(m.to);
    // KS-2460: для FAC найденные шахи рисуются как `correct-attack`
    // (зелёные стрелки атаки на короля), пропущенные — `missed-attack`
    // (оранжевые). Семантически это атаки, не «правильные ходы»
    // вообще — корону шахуем, а не двигаем фигуры абстрактно.
    arrows.push({
      from: m.from,
      to: m.to,
      role: userPicked || solved ? 'correct-attack' : 'missed-attack',
    });
  }

  const highlights: DrillExplanationHighlight[] = [];
  if (enemyKing) {
    highlights.push({ square: enemyKing, role: 'target' });
  }
  for (const sq of correctAnswer.squares) {
    highlights.push({ square: sq, role: 'correct' });
    if (!userSquaresSet.has(sq) && !solved) {
      highlights.push({ square: sq, role: 'missed' });
    }
  }
  for (const sq of userSquaresSet) {
    if (!correctSquaresSet.has(sq)) {
      highlights.push({ square: sq, role: 'wrong' });
    }
  }

  const movesLabel = expectedMoves
    .map((m) => `${m.from}${m.to}`)
    .join(', ');
  const notes: DrillExplanationNote[] = [
    {
      key: 'drills.explanation.findAllChecks.correct',
      params: {
        count: correctAnswer.squares.length,
        moves: movesLabel || formatSquareList(correctAnswer.squares),
      },
      tone: solved ? 'success' : 'info',
    },
  ];

  // Missed / wrong списки.
  if (!solved && userAnswer && userAnswer.shape === 'squares') {
    const missed = correctAnswer.squares.filter((s) => !userSquaresSet.has(s));
    if (missed.length > 0) {
      notes.push({
        key: 'drills.explanation.findAllChecks.missed',
        params: { moves: formatSquareList(missed) },
        tone: 'missed',
      });
    }
    const wrong = userAnswer.squares.filter((s) => !correctSquaresSet.has(s));
    if (wrong.length > 0) {
      notes.push({
        key: 'drills.explanation.findAllChecks.wrong',
        params: { moves: formatSquareList(wrong) },
        tone: 'wrong',
      });
    }
  }

  // Per-move discovered / double теги — методика KS-2454 (учить
  // отличать механику).
  for (const tag of tags) {
    if (tag.kind === 'discovered') {
      notes.push({
        key: 'drills.explanation.findAllChecks.tagDiscovered',
        params: { from: tag.from, to: tag.to },
        tone: 'info',
      });
    } else if (tag.kind === 'double') {
      notes.push({
        key: 'drills.explanation.findAllChecks.tagDouble',
        params: { from: tag.from, to: tag.to },
        tone: 'info',
      });
    }
  }

  return { arrows, highlights, notes };
}
