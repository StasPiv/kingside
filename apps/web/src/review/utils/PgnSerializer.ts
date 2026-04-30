import type { ChessMove, NodeAnnotations } from '../types';
import { serializeCommentWithMacros } from './commentMacros';

/**
 * KS-2152: аннотации читаются из мапы annotationsByIndex, а не из move.
 * Если мапа не передана, используем move.annotations как fallback (для
 * совместимости со старыми вызовами и тестами).
 */
function getAnnotations(
  move: ChessMove,
  byIndex?: Record<number, NodeAnnotations>,
): NodeAnnotations | undefined {
  if (byIndex && Object.prototype.hasOwnProperty.call(byIndex, move.globalIndex)) {
    return byIndex[move.globalIndex];
  }
  return move.annotations;
}

function serializeMoves(
  moves: ChessMove[],
  byIndex?: Record<number, NodeAnnotations>,
): string {
  const parts: string[] = [];
  let needBlackNumber = false;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const moveNumber = Math.ceil(move.ply / 2);
    const isWhiteMove = move.ply % 2 === 1;

    if (isWhiteMove) {
      parts.push(`${moveNumber}.`);
      needBlackNumber = false;
    } else if (i === 0 || needBlackNumber) {
      parts.push(`${moveNumber}...`);
      needBlackNumber = false;
    }

    parts.push(move.san);

    // Serialize NAGs
    if (move.nags && move.nags.length > 0) {
      for (const nag of move.nags) {
        parts.push(`$${nag}`);
      }
    }

    // Serialize comment (including eval/clock/annotations macros)
    // KS-2152: annotations передаются и сериализуются как [%csl][%cal] макросы.
    const fullComment = serializeCommentWithMacros(
      move.comment,
      move.eval,
      move.clock,
      getAnnotations(move, byIndex),
    );
    if (fullComment) {
      parts.push(`{${fullComment}}`);
    }

    if (move.variations && move.variations.length > 0) {
      for (const variation of move.variations) {
        if (variation.length > 0) {
          parts.push(`(${serializeMoves(variation, byIndex)})`);
          needBlackNumber = true;
        }
      }
    }
  }

  return parts.join(' ');
}

export function serializeToAnnotatedPgn(
  history: ChessMove[],
  initialAnnotations?: NodeAnnotations,
  /**
   * KS-2152: аннотации, привязанные к узлам дерева через globalIndex.
   * При сериализации выбираются ОНИ, а не move.annotations — состояние
   * аннотаций живёт в reducer'е useReviewState (annotationsByIndex), а
   * move.annotations используется лишь как промежуточное место при
   * чтении/записи PGN.
   */
  annotationsByIndex?: Record<number, NodeAnnotations>,
): string {
  // KS-2152: leading-комментарий PGN — единственное место, куда можно
  // прицепить аннотации стартовой позиции (у неё нет узла дерева).
  const leading = serializeCommentWithMacros(undefined, undefined, undefined, initialAnnotations);
  const leadingPart = leading ? `{${leading}} ` : '';
  if (history.length === 0) return `${leadingPart}*`.trim();
  return `${leadingPart}${serializeMoves(history, annotationsByIndex)} *`;
}
