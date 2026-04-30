import type { ChessMove, NodeAnnotations } from '../types';
import { serializeCommentWithMacros } from './commentMacros';

function serializeMoves(moves: ChessMove[]): string {
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
      move.annotations,
    );
    if (fullComment) {
      parts.push(`{${fullComment}}`);
    }

    if (move.variations && move.variations.length > 0) {
      for (const variation of move.variations) {
        if (variation.length > 0) {
          parts.push(`(${serializeMoves(variation)})`);
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
): string {
  // KS-2152: leading-комментарий PGN — единственное место, куда можно
  // прицепить аннотации стартовой позиции (у неё нет узла дерева).
  // Стандартный leading-комментарий используется по PGN-спеке для описания
  // партии в целом; в нашем случае пишем туда только [%csl]/[%cal].
  const leading = serializeCommentWithMacros(undefined, undefined, undefined, initialAnnotations);
  const leadingPart = leading ? `{${leading}} ` : '';
  if (history.length === 0) return `${leadingPart}*`.trim();
  return `${leadingPart}${serializeMoves(history)} *`;
}
