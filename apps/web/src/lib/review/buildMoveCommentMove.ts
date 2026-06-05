/**
 * KS-3712. Сборка поля `move` для тела POST `/analyses/review/move-comment`
 * (см. `apps/web/src/api/moveComment.ts`).
 *
 * Чистая функция: получает FEN до хода + UCI хода + классификацию,
 * возвращает структуру `MoveCommentMoveField`. Логика взята из
 * `parsePlayedMove` в `extractFacts.ts` с одним отличием: поле `mate`
 * — реальное число полуходов до мата от состояния перед ходом
 * (1 для сыгранного мата), а не `0` как в legacy-формате `FactsInput`.
 * Прежнее значение 0 эквивалентно «мата нет» в конвенции UCI
 * (`score mate N`, N≥1) — модель не отличала 9.Qg5# от обычного шаха.
 *
 * Если предоставлен `engineMateAfter` (число полуходов до мата с
 * позиции ПОСЛЕ хода, от Stockfish UCI `score mate N`), мы используем
 * его как «дистанцию до мата с учётом продолжения». Значение положительное
 * означает «ходящая сторона матует через N полуходов»; отрицательное —
 * «сторона, которая на ходу после played-хода, получает мат через |N|».
 * Если шах сыгранного хода уже матовый — `mate = 1` независимо от
 * `engineMateAfter` (короткий путь).
 */
import { Chess, type PieceSymbol } from 'chess.js';

import type {
  MoveCommentMoveField,
  MoveClassification,
} from '../../api/moveComment';

type NonKingPiece = 'p' | 'n' | 'b' | 'r' | 'q';
type PromotablePiece = 'q' | 'r' | 'b' | 'n';

function isNonKingPiece(p: PieceSymbol): p is NonKingPiece {
  return p === 'p' || p === 'n' || p === 'b' || p === 'r' || p === 'q';
}

function isPromotablePiece(p: PieceSymbol): p is PromotablePiece {
  return p === 'q' || p === 'r' || p === 'b' || p === 'n';
}

export interface BuildMoveCommentMoveInput {
  fenBefore: string;
  uci: string;
  playedSan: string;
  classification: MoveClassification;
  /**
   * Опционально: `score mate N` от Stockfish на позиции ПОСЛЕ played-хода,
   * POV стороны, которая на ходу после хода (соперник). Если задан и
   * сыгранный ход не ставит мат сразу — мы конвертируем его в число
   * полуходов «от позиции перед ходом» с учётом сделанного хода.
   */
  engineMateAfter?: number | null;
}

export function buildMoveCommentMove(
  input: BuildMoveCommentMoveInput,
): MoveCommentMoveField {
  const { fenBefore, uci, playedSan, classification } = input;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotionRaw = uci.length > 4 ? uci.slice(4, 5) : undefined;

  let parsed: ReturnType<Chess['move']> | null = null;
  let board: Chess | null = null;
  try {
    board = new Chess(fenBefore);
    parsed = board.move({ from, to, promotion: promotionRaw });
  } catch {
    parsed = null;
  }

  if (!parsed || !board) {
    return {
      san: playedSan || uci,
      uci,
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion:
        promotionRaw && isPromotablePiece(promotionRaw as PieceSymbol)
          ? (promotionRaw as PromotablePiece)
          : null,
      classification,
    };
  }

  const flags = parsed.flags ?? '';
  const captured =
    parsed.captured && isNonKingPiece(parsed.captured as PieceSymbol)
      ? (parsed.captured as NonKingPiece)
      : null;
  const promotion =
    parsed.promotion && isPromotablePiece(parsed.promotion as PieceSymbol)
      ? (parsed.promotion as PromotablePiece)
      : null;

  let castling: 'O-O' | 'O-O-O' | null = null;
  if (flags.includes('k')) castling = 'O-O';
  else if (flags.includes('q')) castling = 'O-O-O';

  const san = parsed.san ?? playedSan ?? uci;
  const check = san.includes('+') || san.endsWith('#');

  // Дистанция до мата.
  let mate: number | null = null;
  if (san.endsWith('#')) {
    mate = 1;
  } else {
    try {
      if (board.isCheckmate()) mate = 1;
    } catch {
      /* chess.js не отдал состояние — оставим null */
    }
    if (
      mate === null &&
      input.engineMateAfter != null &&
      Number.isFinite(input.engineMateAfter) &&
      input.engineMateAfter !== 0
    ) {
      // UCI `score mate N` после played-хода — POV соперника на доске
      // ПОСЛЕ хода. Чтобы получить «от состояния перед ходом» с учётом
      // самого хода, нужно прибавить 1 к модулю и сохранить знак,
      // отнесённый к ходящей стороне на fenBefore.
      const absN = Math.abs(input.engineMateAfter) + 1;
      // Если соперник матует — для нас (ходящего) это `-absN`, но
      // поле `mate` в payload одинаково для обеих сторон: положительное
      // = ходящий матует, отрицательное = его матуют.
      mate = input.engineMateAfter > 0 ? -absN : absN;
    }
  }

  return {
    san,
    uci,
    capture: captured,
    check,
    mate,
    castling,
    promotion,
    classification,
  };
}
