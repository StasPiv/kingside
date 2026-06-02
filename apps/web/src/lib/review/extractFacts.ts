/**
 * KS-3614 / ADR-102 §3.4, §8 этап A. Rule-based извлечение фактов о
 * полуходе для LLM-комментариев. Чистая функция, без побочных эффектов.
 *
 * Использование (out of scope здесь — это сделает C, KS-3616):
 *   const facts = extractFacts({ ... });
 *   const comment = await backendReviewCommentService.generate(facts);
 *
 * Не делаем сложных тактических детекторов (вилка/связка/...) — MVP-2.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

import {
  classifyMove,
  expectedScoreFromWdl,
  type MoveClass,
  type Wdl,
} from '@kingside/shared';

import { uciToSan } from '../maia/uciToSan';

// --- public types ----------------------------------------------------------

export type Side = 'white' | 'black';
export type PromotablePiece = 'q' | 'r' | 'b' | 'n';
export type NonKingPiece = 'p' | 'n' | 'b' | 'r' | 'q';
export type GameStage = 'opening' | 'middlegame' | 'endgame';

export interface FactsMove {
  san: string;
  uci: string;
  capture: NonKingPiece | null;
  check: boolean;
  /** Mate-in-N если сам ход даёт/реализует мат, иначе null. */
  mate: number | null;
  castling: 'O-O' | 'O-O-O' | null;
  promotion: PromotablePiece | null;
  en_passant: boolean;
}

export interface FactsMaterialChange {
  piece: NonKingPiece;
  side: Side;
}

export interface FactsHangingPiece {
  square: string;
  piece: NonKingPiece;
  side: Side;
}

export interface FactsSfBest {
  uci: string;
  san: string;
}

export interface FactsMaiaAlternative {
  uci: string;
  san: string;
  probability: number;
  classification: MoveClass;
}

export interface FactsInput {
  ply: number;
  fen: string;
  side: Side;
  move: FactsMove;
  classification: MoveClass;
  /** E_before − E_after, в [−1..+1] (POV ходящей стороны). */
  delta_e: number;
  sf_best: FactsSfBest | null;
  maia_alternative: FactsMaiaAlternative | null;
  stage: GameStage;
  opening_name: string | null;
  material_balance: number;
  material_change: FactsMaterialChange | null;
  hanging_piece: FactsHangingPiece | null;
  mate_threat_after: number | null;
  user_elo: number;
  user_language: 'en' | 'ru';
}

export interface ExtractFactsInput {
  ply: number;
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  playedSan: string;
  sfData: {
    bestUci: string;
    bestSan: string;
    wdlBefore: Wdl;
    /** POV того же игрока (caller инвертировал). */
    wdlAfterPlayed: Wdl;
    /** POV того же игрока. */
    wdlAfterBest: Wdl;
    sfBestPv: string[];
    mateBefore: number | null;
    mateAfter: number | null;
  };
  maiaData: {
    playedProb: number | undefined;
    maiaTopUci: string;
    maiaTopProb: number;
    wdlAfterMaiaTop?: Wdl;
  };
  classification: MoveClass;
  openingName: string | null;
  userElo: number;
  userLanguage: 'en' | 'ru';
}

// --- constants -------------------------------------------------------------

const PIECE_VALUE: Record<NonKingPiece, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

/** ply ≤ OPENING_PLY_LIMIT → stage='opening' (§1.2). */
const OPENING_PLY_LIMIT = 16;
/** Без королей: ≤ ENDGAME_NON_PAWN_PIECES → stage='endgame'. */
const ENDGAME_NON_PAWN_PIECES = 6;

// --- helpers ---------------------------------------------------------------

function sideFromFen(fen: string): Side {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

function oppositeSide(s: Side): Side {
  return s === 'white' ? 'black' : 'white';
}

function colorToSide(c: Color): Side {
  return c === 'w' ? 'white' : 'black';
}

function isPromotablePiece(p: PieceSymbol): p is PromotablePiece {
  return p === 'q' || p === 'r' || p === 'b' || p === 'n';
}

function isNonKingPiece(p: PieceSymbol): p is NonKingPiece {
  return p === 'p' || p === 'n' || p === 'b' || p === 'r' || p === 'q';
}

/**
 * Количество не-пешечных фигур (без королей) на доске. Используется
 * для определения эндшпиля.
 */
function countNonPawnPieces(fen: string): number {
  try {
    const c = new Chess(fen);
    const board = c.board();
    let n = 0;
    for (const row of board) {
      for (const cell of row) {
        if (!cell) continue;
        if (cell.type === 'p' || cell.type === 'k') continue;
        n++;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

function getStage(fen: string, ply: number): GameStage {
  if (ply <= OPENING_PLY_LIMIT) return 'opening';
  if (countNonPawnPieces(fen) <= ENDGAME_NON_PAWN_PIECES) return 'endgame';
  return 'middlegame';
}

/**
 * Material balance POV `side` (pawn units). Сумма ценностей фигур
 * `side` минус соперника. Король не учитывается (он всегда на доске).
 */
function materialBalance(fen: string, side: Side): number {
  try {
    const c = new Chess(fen);
    const board = c.board();
    let acc = 0;
    for (const row of board) {
      for (const cell of row) {
        if (!cell) continue;
        if (!isNonKingPiece(cell.type)) continue;
        const value = PIECE_VALUE[cell.type];
        if (colorToSide(cell.color) === side) acc += value;
        else acc -= value;
      }
    }
    return acc;
  } catch {
    return 0;
  }
}

/**
 * MVP §1.3. Простая эвристика «висящая фигура».
 *
 *   В позиции `fenAfter` (на ходу — соперник того, кто только что
 *   сыграл — поэтому «своя» фигура = POV игрока, который ходил)
 *   ищем фигуру:
 *     - атакована хотя бы одной фигурой соперника
 *     - И (нет защитников И value ≥ 3) ИЛИ (минимальный атакующий
 *       по ценности меньше самой фигуры И нет защитников).
 *   Возвращаем самую ценную из найденных (queen > rook > bishop/knight
 *   > pawn). Только первую — для LLM достаточно одного факта.
 *
 *   False positives на «защищена королём» — допустимы (LLM скажет
 *   «висит ферзь» — пользователь увидит, что король держит).
 */
function findHangingPiece(fenAfter: string): FactsHangingPiece | null {
  let c: Chess;
  try {
    c = new Chess(fenAfter);
  } catch {
    return null;
  }
  const board = c.board();
  const candidates: Array<{
    square: Square;
    piece: NonKingPiece;
    side: Side;
    value: number;
  }> = [];

  for (let rIdx = 0; rIdx < board.length; rIdx++) {
    const row = board[rIdx];
    for (let fIdx = 0; fIdx < row.length; fIdx++) {
      const cell = row[fIdx];
      if (!cell) continue;
      if (!isNonKingPiece(cell.type)) continue;
      const square = cell.square as Square;
      const ourColor = cell.color;
      const enemyColor: Color = ourColor === 'w' ? 'b' : 'w';
      let attackers: Square[];
      let defenders: Square[];
      try {
        attackers = c.attackers(square, enemyColor) as Square[];
        defenders = c.attackers(square, ourColor) as Square[];
      } catch {
        continue;
      }
      if (attackers.length === 0) continue;

      const pieceValue = PIECE_VALUE[cell.type];
      const minAttackerValue = Math.min(
        ...attackers.map((sq) => {
          const a = c.get(sq);
          return a && isNonKingPiece(a.type) ? PIECE_VALUE[a.type] : 100;
        }),
      );

      const undefendedAndValuable =
        defenders.length === 0 && pieceValue >= 3;
      const attackedByCheaper =
        minAttackerValue < pieceValue && defenders.length === 0;

      if (undefendedAndValuable || attackedByCheaper) {
        candidates.push({
          square,
          piece: cell.type,
          side: colorToSide(cell.color),
          value: pieceValue,
        });
      }
    }
  }

  if (candidates.length === 0) return null;
  // Самая ценная — первая (queen > rook > ...).
  candidates.sort((a, b) => b.value - a.value);
  const top = candidates[0];
  return { square: top.square, piece: top.piece, side: top.side };
}

interface ParsedMove {
  san: string;
  uci: string;
  capture: NonKingPiece | null;
  check: boolean;
  mate: number | null;
  castling: 'O-O' | 'O-O-O' | null;
  promotion: PromotablePiece | null;
  en_passant: boolean;
}

function parsePlayedMove(
  fenBefore: string,
  uci: string,
  sanFallback: string,
): ParsedMove {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotionRaw = uci.length > 4 ? uci.slice(4, 5) : undefined;

  let m: ReturnType<Chess['move']> | null = null;
  try {
    const c = new Chess(fenBefore);
    m = c.move({ from, to, promotion: promotionRaw });
  } catch {
    m = null;
  }

  if (!m) {
    // Defensive: вернуть «пустой» moveвидь данных, минимум.
    return {
      san: sanFallback || uci,
      uci,
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion:
        promotionRaw && isPromotablePiece(promotionRaw as PieceSymbol)
          ? (promotionRaw as PromotablePiece)
          : null,
      en_passant: false,
    };
  }

  const flags = m.flags ?? '';
  const captured =
    m.captured && isNonKingPiece(m.captured as PieceSymbol)
      ? (m.captured as NonKingPiece)
      : null;
  const promotion =
    m.promotion && isPromotablePiece(m.promotion as PieceSymbol)
      ? (m.promotion as PromotablePiece)
      : null;

  let castling: 'O-O' | 'O-O-O' | null = null;
  if (flags.includes('k')) castling = 'O-O';
  else if (flags.includes('q')) castling = 'O-O-O';

  const san = m.san ?? sanFallback ?? uci;
  const check = san.includes('+') || san.endsWith('#');
  // mate-in-0 = сам ход — мат. Для mate-in-N после хода используется
  // `mate_threat_after` (см. FactsInput). Здесь — только сам ход.
  const mate = san.endsWith('#') ? 0 : null;

  return {
    san,
    uci,
    capture: captured,
    check,
    mate,
    castling,
    promotion,
    en_passant: flags.includes('e'),
  };
}

// --- main ------------------------------------------------------------------

export function extractFacts(input: ExtractFactsInput): FactsInput {
  const side = sideFromFen(input.fenBefore);
  const move = parsePlayedMove(input.fenBefore, input.playedUci, input.playedSan);

  const stage = getStage(input.fenBefore, input.ply);
  const opening_name = stage === 'opening' ? input.openingName : null;

  const material_balance = materialBalance(input.fenAfter, side);
  const material_change: FactsMaterialChange | null = move.capture
    ? { piece: move.capture, side: oppositeSide(side) }
    : null;

  const hanging_piece = findHangingPiece(input.fenAfter);

  const eBefore = expectedScoreFromWdl(input.sfData.wdlBefore);
  const eAfter = expectedScoreFromWdl(input.sfData.wdlAfterPlayed);
  const delta_e = eBefore - eAfter;

  const sf_best: FactsSfBest | null =
    input.playedUci === input.sfData.bestUci
      ? null
      : { uci: input.sfData.bestUci, san: input.sfData.bestSan };

  let maia_alternative: FactsMaiaAlternative | null = null;
  const maiaTopUci = input.maiaData.maiaTopUci;
  const maiaSameAsBest = maiaTopUci === input.sfData.bestUci;
  const maiaSameAsPlayed = maiaTopUci === input.playedUci;
  if (maiaTopUci && !maiaSameAsBest && !maiaSameAsPlayed) {
    const maiaSan = uciToSan(input.fenBefore, maiaTopUci);
    const maiaWdlAfter = input.maiaData.wdlAfterMaiaTop;
    // classifyMove: если wdlAfterMaiaTop недоступен — нейтральный 'good'
    // (см. ADR-066 §2: ни WDL, ни cp → 'good').
    const maiaClass: MoveClass = maiaWdlAfter
      ? classifyMove({
          wdlBefore: input.sfData.wdlBefore,
          wdlAfter: maiaWdlAfter,
        })
      : 'good';
    maia_alternative = {
      uci: maiaTopUci,
      san: maiaSan,
      probability: input.maiaData.maiaTopProb,
      classification: maiaClass,
    };
  }

  return {
    ply: input.ply,
    fen: input.fenBefore,
    side,
    move,
    classification: input.classification,
    delta_e,
    sf_best,
    maia_alternative,
    stage,
    opening_name,
    material_balance,
    material_change,
    hanging_piece,
    mate_threat_after: input.sfData.mateAfter,
    user_elo: input.userElo,
    user_language: input.userLanguage,
  };
}
