/**
 * KS-3614 / ADR-102 §3.4, §8 этап A — MVP-1.
 * KS-3623 / ADR-103 rev 2 §3.2, §5 — MVP-2: тактические мотивы,
 * расширенный hanging_piece, threats_created/threats_missed,
 * sf_best.line, заглушка positional_shifts (заполняется backend).
 *
 * Чистая функция, без побочных эффектов, без вызова движка.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

import {
  classifyMove,
  expectedScoreFromWdl,
  type MoveClass,
  type PositionalSubterm,
  type Wdl,
} from '@kingside/shared';

import { uciToSan } from '../maia/uciToSan';

// --- public types ----------------------------------------------------------

export type Side = 'white' | 'black';
export type PromotablePiece = 'q' | 'r' | 'b' | 'n';
export type NonKingPiece = 'p' | 'n' | 'b' | 'r' | 'q';
export type AnyPiece = NonKingPiece | 'k';
export type GameStage = 'opening' | 'middlegame' | 'endgame';

/** ADR-103 §3.2 — 6 детекторов MVP-2. */
export type TacticalMotif =
  | 'fork'
  | 'double_attack'
  | 'pin'
  | 'skewer'
  | 'discovered_attack'
  | 'back_rank_weak';

/**
 * ADR-103 §6.5 — позиционные ярлыки. На фронте всегда `[]`,
 * заполняет backend через SF 15.1 classical eval. Точный union
 * объявлен в packages/shared (F2), здесь сознательно string.
 */
export type PositionalShiftId = string;

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

/** Атакующий/защищающий участник размена на квадрате висячей фигуры. */
export interface ExchangeParticipant {
  piece: AnyPiece;
  square: string;
}

export interface FactsHangingPiece {
  square: string;
  piece: NonKingPiece;
  side: Side;
  /** Атакующие фигуры противоположной стороны (фигуры стороны, которая может взять). */
  attackers: ExchangeParticipant[];
  /** Защитники той же стороны, что и висячая фигура. */
  defenders: ExchangeParticipant[];
  /** SEE-подобный итог размена (>0 — взятие выгодно атакующему). */
  net_material_if_taken: number;
}

export interface FactsSfBestLineMove {
  uci: string;
  san: string;
}

export interface FactsSfBest {
  uci: string;
  san: string;
  /** 2–3 хода SAN продолжения из sfBestPv. Пустой массив, если PV нет. */
  line: string[];
}

export interface FactsMaiaAlternative {
  uci: string;
  san: string;
  probability: number;
  classification: MoveClass;
}

export interface ThreatTarget {
  piece: AnyPiece;
  square: string;
}

export interface WinsMaterialThreat {
  piece: AnyPiece;
  square: string;
  net_value: number;
}

export interface ThreatsCreated {
  mate_in?: number;
  wins_material?: WinsMaterialThreat;
  double_attack?: boolean;
  targets?: ThreatTarget[];
}

export interface ThreatsMissed {
  mate_in?: number;
  wins_material?: WinsMaterialThreat;
  counter_threat?: string;
}

export interface FactsInput {
  ply: number;
  fen: string;
  /** ADR-103 §5 — позиция после хода, для backend SF eval. */
  fen_after: string;
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
  /** ADR-103 §5 — мотивы после хода (см. TacticalMotif). */
  tactical_motifs: TacticalMotif[];
  /** ADR-103 §5 — что создаёт ход. */
  threats_created: ThreatsCreated;
  /** ADR-103 §5 — что упускает слабый ход относительно sf_best. */
  threats_missed: ThreatsMissed;
  /** ADR-103 §6.5 — на фронте всегда []; заполняется backend. */
  positional_shifts: PositionalShiftId[];
  /**
   * KS-3650 / ADR-107 rev 2 §3.5 — сырые позиционные подкомпоненты
   * classical-оценки Stockfish 16 (`subterms` из UCI `eval json`).
   * Заполняется оркестратором (`useGameReview`) через `evalTrace()`
   * над WASM-сборкой `stockfish-16-trace.*`. Если WASM не загрузился
   * или вернул пусто — `[]` (graceful, prompt продолжит работать с
   * агрегатными `positional_shifts`).
   */
  positional_subterms: PositionalSubterm[];
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
  /**
   * KS-3650 / ADR-107 rev 2 §6 F1. Опционально — массив позиционных
   * подкомпонент от `evalTrace(fenAfter)`. Передаётся оркестратором
   * только на NAG-фокус ходах (где LLM-комментарий действительно
   * нужен). При отсутствии — `positional_subterms` в выходном
   * `FactsInput` будет `[]`.
   */
  positionalSubterms?: PositionalSubterm[];
}

// --- constants -------------------------------------------------------------

const PIECE_VALUE: Record<NonKingPiece, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

/** Значение короля в SEE — заведомо больше любой фигуры. В реальном
 *  размене король не может «погибнуть», но для negamax работает корректно
 *  как стоп-маркер: атакующего королём защитника бить любым своим
 *  материалом невыгодно. */
const KING_VALUE = 1000;

/** ply ≤ OPENING_PLY_LIMIT → stage='opening' (§1.2). */
const OPENING_PLY_LIMIT = 16;
/** Без королей: ≤ ENDGAME_NON_PAWN_PIECES → stage='endgame'. */
const ENDGAME_NON_PAWN_PIECES = 6;

/** Минимальная «ценность» цели, чтобы угроза считалась реальной. */
const THREAT_MIN_NET = 1;

/** Лимит ходов SAN в sf_best.line. */
const SF_BEST_LINE_PLIES = 3;

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

function sideToColor(s: Side): Color {
  return s === 'white' ? 'w' : 'b';
}

function isPromotablePiece(p: PieceSymbol): p is PromotablePiece {
  return p === 'q' || p === 'r' || p === 'b' || p === 'n';
}

function isNonKingPiece(p: PieceSymbol): p is NonKingPiece {
  return p === 'p' || p === 'n' || p === 'b' || p === 'r' || p === 'q';
}

function pieceVal(p: PieceSymbol | undefined): number {
  if (!p) return 0;
  if (p === 'k') return KING_VALUE;
  return PIECE_VALUE[p as NonKingPiece];
}

function isLongRange(p: PieceSymbol): p is 'b' | 'r' | 'q' {
  return p === 'b' || p === 'r' || p === 'q';
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
 * `side` минус соперника. Король не учитывается.
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
 * SEE-подобный статический подсчёт оптимального размена на квадрате
 * `target`, где стоит фигура. Считаем выигрыш стороны `attackerColor`,
 * последовательно беря наименее ценной фигурой и останавливаясь
 * там, где невыгодно. Negamax back-propagation.
 *
 * Возвращает баланс в pawn units (>0 — атакующему выгодно).
 */
function staticExchangeEval(
  c: Chess,
  target: Square,
  attackerColor: Color,
): number {
  const victim = c.get(target);
  if (!victim) return 0;

  const defenderColor: Color = attackerColor === 'w' ? 'b' : 'w';
  let attackerSqs: Square[];
  let defenderSqs: Square[];
  try {
    attackerSqs = c.attackers(target, attackerColor) as Square[];
    defenderSqs = c.attackers(target, defenderColor) as Square[];
  } catch {
    return 0;
  }
  if (attackerSqs.length === 0) return 0;

  const attackerVals = attackerSqs
    .map((sq) => pieceVal(c.get(sq)?.type))
    .sort((a, b) => a - b);
  const defenderVals = defenderSqs
    .map((sq) => pieceVal(c.get(sq)?.type))
    .sort((a, b) => a - b);

  const gains: number[] = [pieceVal(victim.type)];
  // На квадрате после первого взятия стоит наименьший атакующий.
  let onSquare = attackerVals.shift() as number;
  let toMove: 'def' | 'att' = 'def';

  while (true) {
    if (toMove === 'def') {
      if (defenderVals.length === 0) break;
      gains.push(onSquare - gains[gains.length - 1]);
      onSquare = defenderVals.shift() as number;
      toMove = 'att';
    } else {
      if (attackerVals.length === 0) break;
      gains.push(onSquare - gains[gains.length - 1]);
      onSquare = attackerVals.shift() as number;
      toMove = 'def';
    }
  }

  // Back-propagate стоп-решения. Сторона на шаге d может либо
  // забрать (gain[d]) либо остановиться (взять предыдущий gain[d-1]
  // как итог), выбирая лучшее для себя.
  for (let i = gains.length - 1; i > 0; i--) {
    gains[i - 1] = -Math.max(-gains[i - 1], gains[i]);
  }
  return gains[0];
}

interface AttackerInfo {
  square: Square;
  piece: AnyPiece;
}

function collectAttackers(
  c: Chess,
  target: Square,
  color: Color,
): AttackerInfo[] {
  let squares: Square[] = [];
  try {
    squares = c.attackers(target, color) as Square[];
  } catch {
    return [];
  }
  const result: AttackerInfo[] = [];
  for (const sq of squares) {
    const p = c.get(sq);
    if (!p) continue;
    result.push({ square: sq, piece: p.type });
  }
  return result;
}

/**
 * ADR-103 §5 — расширенный findHangingPiece. Сохраняет MVP-1 семантику
 * (висит = атакована и (нет защиты И value≥3) ИЛИ дешевле атакующий
 * без защиты), но дополнительно возвращает списки атакующих/защитников
 * и SEE-подобный net_material_if_taken.
 *
 * В позиции `fenAfter` ход у соперника, поэтому «висит» — фигура того,
 * кто только что сыграл (если её можно дёшево забрать).
 */
function findHangingPiece(fenAfter: string): FactsHangingPiece | null {
  let c: Chess;
  try {
    c = new Chess(fenAfter);
  } catch {
    return null;
  }
  const board = c.board();
  type Candidate = {
    square: Square;
    piece: NonKingPiece;
    side: Side;
    value: number;
    attackers: ExchangeParticipant[];
    defenders: ExchangeParticipant[];
    net: number;
  };
  const candidates: Candidate[] = [];

  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      if (!isNonKingPiece(cell.type)) continue;
      const square = cell.square as Square;
      const ourColor = cell.color;
      const enemyColor: Color = ourColor === 'w' ? 'b' : 'w';

      const attackers = collectAttackers(c, square, enemyColor);
      if (attackers.length === 0) continue;
      const defenders = collectAttackers(c, square, ourColor);

      const pieceValue = PIECE_VALUE[cell.type];
      const minAttackerValue = Math.min(
        ...attackers.map((a) => pieceVal(a.piece)),
      );

      const undefendedAndValuable =
        defenders.length === 0 && pieceValue >= 3;
      const attackedByCheaper =
        minAttackerValue < pieceValue && defenders.length === 0;

      if (!undefendedAndValuable && !attackedByCheaper) continue;

      const net = staticExchangeEval(c, square, enemyColor);

      candidates.push({
        square,
        piece: cell.type,
        side: colorToSide(cell.color),
        value: pieceValue,
        attackers: attackers.map((a) => ({ piece: a.piece, square: a.square })),
        defenders: defenders.map((d) => ({ piece: d.piece, square: d.square })),
        net,
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.value - a.value);
  const top = candidates[0];
  return {
    square: top.square,
    piece: top.piece,
    side: top.side,
    attackers: top.attackers,
    defenders: top.defenders,
    net_material_if_taken: top.net,
  };
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

// --- мотивы ----------------------------------------------------------------

/** Собирает все фигуры цвета `color`. */
function collectPieces(
  c: Chess,
  color: Color,
): Array<{ square: Square; piece: PieceSymbol }> {
  const board = c.board();
  const out: Array<{ square: Square; piece: PieceSymbol }> = [];
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.color !== color) continue;
      out.push({ square: cell.square as Square, piece: cell.type });
    }
  }
  return out;
}

/** Множество вражеских квадратов, которые атакует `from` (в текущей позиции c). */
function attacksFromSquare(c: Chess, from: Square, ourColor: Color): Square[] {
  const enemyColor: Color = ourColor === 'w' ? 'b' : 'w';
  const enemies = collectPieces(c, enemyColor);
  const out: Square[] = [];
  for (const e of enemies) {
    const att = collectAttackers(c, e.square, ourColor);
    if (att.some((a) => a.square === from)) out.push(e.square);
  }
  return out;
}

/**
 * ADR-103 §3.2 — fork. Одна фигура стороны `side` атакует ≥2 цели,
 * каждая из которых либо король, либо не дешевле атакующей.
 */
function detectFork(c: Chess, side: Side): boolean {
  const color = sideToColor(side);
  const my = collectPieces(c, color);
  for (const p of my) {
    const attackerValue = pieceVal(p.piece);
    const targets = attacksFromSquare(c, p.square, color);
    if (targets.length < 2) continue;
    let valuableTargets = 0;
    for (const t of targets) {
      const piece = c.get(t);
      if (!piece) continue;
      if (piece.type === 'k' || pieceVal(piece.type) >= attackerValue) {
        valuableTargets++;
      }
    }
    if (valuableTargets >= 2) return true;
  }
  return false;
}

/**
 * ADR-103 §3.2 — double_attack: ход создаёт ≥2 новые угрозы взятия
 * ценных фигур, которых не было в позиции до хода. «Ценные» — SEE > 0
 * или цель — король. Это включает в себя fork как частный случай, но
 * также покрывает «вскрытие + собственное нападение».
 */
function detectDoubleAttack(
  cBefore: Chess,
  cAfter: Chess,
  side: Side,
): boolean {
  const before = enumerateThreats(cBefore, side);
  const after = enumerateThreats(cAfter, side);
  const beforeKeys = new Set(before.map((t) => `${t.targetSquare}`));
  let newCount = 0;
  for (const a of after) {
    if (!beforeKeys.has(a.targetSquare)) newCount++;
  }
  return newCount >= 2;
}

interface ThreatEntry {
  targetSquare: Square;
  targetPiece: AnyPiece;
  bySquare: Square;
  net: number;
}

/**
 * Перечислить все «материальные угрозы» стороны `side` в позиции:
 * вражеская фигура, атакованная нашей, с положительным SEE (или цель — король).
 * Группируется по цели — каждая цель ровно один раз (берём лучшего атакующего).
 */
function enumerateThreats(c: Chess, side: Side): ThreatEntry[] {
  const myColor = sideToColor(side);
  const enemyColor: Color = myColor === 'w' ? 'b' : 'w';
  const enemies = collectPieces(c, enemyColor);
  const out: ThreatEntry[] = [];

  for (const e of enemies) {
    const att = collectAttackers(c, e.square, myColor);
    if (att.length === 0) continue;
    if (e.piece === 'k') {
      out.push({
        targetSquare: e.square,
        targetPiece: 'k',
        bySquare: att[0].square,
        net: KING_VALUE,
      });
      continue;
    }
    const net = staticExchangeEval(c, e.square, myColor);
    if (net >= THREAT_MIN_NET) {
      // лучший атакующий — с минимальной ценностью
      const best = att.reduce((a, b) =>
        pieceVal(a.piece) <= pieceVal(b.piece) ? a : b,
      );
      out.push({
        targetSquare: e.square,
        targetPiece: e.piece as AnyPiece,
        bySquare: best.square,
        net,
      });
    }
  }
  return out;
}

/**
 * Pin/skewer общий ray-scan. Возвращает мотив для луча, если он есть.
 * Pin: первая_цель.value < вторая_цель.value (или вторая — король),
 *      «связанная» (первая) не может двинуться без потери второй.
 * Skewer: первая_цель.value > вторая_цель.value (или первая — король).
 *
 * Сторона `side` — атакующая. Идём от каждой нашей дальнобойной фигуры
 * по доступным ей лучам.
 */
function rayScanPinOrSkewer(
  c: Chess,
  side: Side,
  motif: 'pin' | 'skewer',
): boolean {
  const myColor = sideToColor(side);
  const enemyColor: Color = myColor === 'w' ? 'b' : 'w';
  const my = collectPieces(c, myColor);

  const rookDirs: Array<[number, number]> = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  const bishopDirs: Array<[number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  function sqToCoord(sq: Square): [number, number] {
    const file = sq.charCodeAt(0) - 97; // a=0
    const rank = parseInt(sq[1], 10) - 1; // 0..7
    return [file, rank];
  }
  function coordToSq(file: number, rank: number): Square | null {
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return (String.fromCharCode(97 + file) + String(rank + 1)) as Square;
  }

  for (const p of my) {
    if (!isLongRange(p.piece)) continue;
    const dirs: Array<[number, number]> =
      p.piece === 'r'
        ? rookDirs
        : p.piece === 'b'
          ? bishopDirs
          : [...rookDirs, ...bishopDirs];

    const [f0, r0] = sqToCoord(p.square);
    for (const [df, dr] of dirs) {
      let first: { sq: Square; piece: PieceSymbol; color: Color } | null = null;
      let second: { sq: Square; piece: PieceSymbol; color: Color } | null = null;
      for (let step = 1; step <= 7; step++) {
        const sq = coordToSq(f0 + df * step, r0 + dr * step);
        if (!sq) break;
        const piece = c.get(sq);
        if (!piece) continue;
        if (!first) {
          first = { sq, piece: piece.type, color: piece.color };
          if (first.color === myColor) break; // свой блокирует луч
          continue;
        }
        if (!second) {
          second = { sq, piece: piece.type, color: piece.color };
          break;
        }
      }
      if (!first || !second) continue;
      if (first.color !== enemyColor || second.color !== enemyColor) continue;

      const v1 = pieceVal(first.piece);
      const v2 = pieceVal(second.piece);
      if (motif === 'pin') {
        // более ценная сзади (или король)
        if (v2 > v1 || second.piece === 'k') return true;
      } else {
        // skewer: более ценная впереди (или король)
        if (v1 > v2 || first.piece === 'k') return true;
      }
    }
  }
  return false;
}

function detectPin(c: Chess, side: Side): boolean {
  return rayScanPinOrSkewer(c, side, 'pin');
}

function detectSkewer(c: Chess, side: Side): boolean {
  return rayScanPinOrSkewer(c, side, 'skewer');
}

/**
 * ADR-103 §3.2 — discovered_attack. После хода наша дальнобойная фигура
 * атакует ценную цель противника по лучу, и квадрат `from` (откуда ушла
 * сходившая фигура) лежит на этом луче между нашей дальнобойной и целью.
 */
function detectDiscoveredAttack(
  cAfter: Chess,
  side: Side,
  fromSquare: Square,
): boolean {
  const myColor = sideToColor(side);
  const my = collectPieces(cAfter, myColor);

  const rookDirs: Array<[number, number]> = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  const bishopDirs: Array<[number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  const [fromFile, fromRank] = [
    fromSquare.charCodeAt(0) - 97,
    parseInt(fromSquare[1], 10) - 1,
  ];

  for (const p of my) {
    if (!isLongRange(p.piece)) continue;
    const dirs: Array<[number, number]> =
      p.piece === 'r'
        ? rookDirs
        : p.piece === 'b'
          ? bishopDirs
          : [...rookDirs, ...bishopDirs];

    const f0 = p.square.charCodeAt(0) - 97;
    const r0 = parseInt(p.square[1], 10) - 1;
    for (const [df, dr] of dirs) {
      let crossedFrom = false;
      for (let step = 1; step <= 7; step++) {
        const f = f0 + df * step;
        const r = r0 + dr * step;
        if (f < 0 || f > 7 || r < 0 || r > 7) break;
        if (f === fromFile && r === fromRank) {
          crossedFrom = true;
        }
        const sq = (String.fromCharCode(97 + f) + String(r + 1)) as Square;
        const piece = cAfter.get(sq);
        if (!piece) continue;
        if (piece.color === myColor) break;
        // первая встретившаяся вражеская
        if (!crossedFrom) break; // атакует, но не через ушедшую — это не discovered
        const v = pieceVal(piece.type);
        const myV = pieceVal(p.piece);
        if (piece.type === 'k' || v >= myV) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * ADR-103 §3.2 — back_rank_weak. У стороны противоположной `side`
 * (т.е. кто сейчас на ходу) король стоит на «своей» крайней горизонтали,
 * три пешки перед ним блокируют побег, и у `side` есть ладья/ферзь
 * на этой горизонтали (или на доступном пути по полуоткрытой линии),
 * способный потенциально дать мат по последнему ряду.
 */
function detectBackRankWeak(c: Chess, side: Side): boolean {
  const myColor = sideToColor(side);
  const oppColor: Color = myColor === 'w' ? 'b' : 'w';

  // Найти короля противника
  const board = c.board();
  let kingSq: Square | null = null;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.color === oppColor && cell.type === 'k') {
        kingSq = cell.square as Square;
      }
    }
  }
  if (!kingSq) return false;

  const kingRank = parseInt(kingSq[1], 10); // 1..8
  // Для чёрных «свой» last rank = 8; для белых = 1.
  const expectedRank = oppColor === 'w' ? 1 : 8;
  if (kingRank !== expectedRank) return false;

  // Три пешки перед королём (предыдущая горизонталь, файлы king-1..king+1).
  const kingFile = kingSq.charCodeAt(0) - 97; // 0..7
  const frontRank = oppColor === 'w' ? 2 : 7; // одна горизонталь к центру
  const fronts: Square[] = [];
  for (const df of [-1, 0, 1]) {
    const f = kingFile + df;
    if (f < 0 || f > 7) continue;
    fronts.push(
      (String.fromCharCode(97 + f) + String(frontRank)) as Square,
    );
  }
  let pawnsInFront = 0;
  for (const sq of fronts) {
    const piece = c.get(sq);
    if (piece && piece.color === oppColor && piece.type === 'p') {
      pawnsInFront++;
    }
  }
  // Нужны минимум 2 пешки чтобы блокировать побег (на crayon-king у
  // боковой 3 фронтальные клетки → 2 пешки уже формируют ловушку).
  if (pawnsInFront < 2) return false;

  // Нет «дырки» в первом ряду рядом с королём — но это «дырки» в смысле
  // пустых полей на back-rank, занятых самим королём; их и не должно быть.
  // Проверяем: на нашей последней горизонтали есть ладья или ферзь
  // потенциально способный матовать.
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.color !== myColor) continue;
      if (cell.type !== 'r' && cell.type !== 'q') continue;
      // ладья/ферзь должна стоять либо уже на back-rank, либо иметь
      // прямой путь к нему по открытой линии — для MVP достаточно факта
      // присутствия r/q на доске + блокированной last-rank противника.
      return true;
    }
  }
  return false;
}

function detectMotifs(
  cBefore: Chess,
  cAfter: Chess,
  side: Side,
  fromSquare: Square,
): TacticalMotif[] {
  const motifs: TacticalMotif[] = [];
  if (detectFork(cAfter, side)) motifs.push('fork');
  if (detectDoubleAttack(cBefore, cAfter, side)) motifs.push('double_attack');
  if (detectPin(cAfter, side)) motifs.push('pin');
  if (detectSkewer(cAfter, side)) motifs.push('skewer');
  if (detectDiscoveredAttack(cAfter, side, fromSquare))
    motifs.push('discovered_attack');
  if (detectBackRankWeak(cAfter, side)) motifs.push('back_rank_weak');
  return motifs;
}

// --- threats ---------------------------------------------------------------

/**
 * Что создаёт ход. Для оценки «мат-угрозы» используем mateAfter (POV
 * сходившего): mateAfter>0 → мы матуем через N. Для wins_material —
 * лучшую материальную угрозу из enumerateThreats(cAfter, side).
 */
function buildThreatsCreated(
  cBefore: Chess,
  cAfter: Chess,
  side: Side,
  mateAfter: number | null,
): ThreatsCreated {
  const out: ThreatsCreated = {};

  if (mateAfter !== null && mateAfter > 0) {
    out.mate_in = mateAfter;
  }

  const after = enumerateThreats(cAfter, side);
  if (after.length > 0) {
    // wins_material — лучшая материальная угроза БЕЗ короля
    // (мат-угроза отдельно идёт через mate_in).
    const material = after.filter((t) => t.targetPiece !== 'k');
    if (material.length > 0) {
      const best = [...material].sort((a, b) => b.net - a.net)[0];
      if (best.net >= THREAT_MIN_NET) {
        out.wins_material = {
          piece: best.targetPiece,
          square: best.targetSquare,
          net_value: best.net,
        };
      }
    }
    if (after.length >= 2) {
      out.double_attack = true;
    }
    out.targets = after.map((t) => ({
      piece: t.targetPiece,
      square: t.targetSquare,
    }));
  } else if (detectDoubleAttack(cBefore, cAfter, side)) {
    // редкий кейс — две новые угрозы стали возможны, но в этой
    // позиции SEE их не подсветил (например, цели — пешки).
    out.double_attack = true;
  }

  return out;
}

/**
 * Что упустил слабый ход. Применяем sf_best.uci к fenBefore, считаем
 * threats_created на полученной позиции, вычитаем то, что есть в реально
 * сыгранном ходе.
 */
function buildThreatsMissed(
  fenBefore: string,
  sfBestUci: string | null,
  realThreats: ThreatsCreated,
  side: Side,
  mateAfterBest: number | null,
): ThreatsMissed {
  if (!sfBestUci) return {};
  let cBefore: Chess;
  try {
    cBefore = new Chess(fenBefore);
  } catch {
    return {};
  }
  const fromBest = sfBestUci.slice(0, 2);
  const toBest = sfBestUci.slice(2, 4);
  const promotionBest = sfBestUci.length > 4 ? sfBestUci.slice(4, 5) : undefined;
  let cAfterBest: Chess;
  try {
    cAfterBest = new Chess(fenBefore);
    const mv = cAfterBest.move({
      from: fromBest,
      to: toBest,
      promotion: promotionBest,
    });
    if (!mv) return {};
  } catch {
    return {};
  }

  const bestThreats = buildThreatsCreated(
    cBefore,
    cAfterBest,
    side,
    mateAfterBest,
  );
  const out: ThreatsMissed = {};

  // mate упущен, если best матует, а реально сыгранный — нет/слабее
  if (
    bestThreats.mate_in !== undefined &&
    (realThreats.mate_in === undefined ||
      bestThreats.mate_in < realThreats.mate_in)
  ) {
    out.mate_in = bestThreats.mate_in;
  }

  // wins_material упущен, если best выигрывает больше или реально не выигрывает
  if (bestThreats.wins_material) {
    const realNet = realThreats.wins_material?.net_value ?? 0;
    if (bestThreats.wins_material.net_value > realNet) {
      out.wins_material = bestThreats.wins_material;
    }
  }

  return out;
}

// --- sf_best.line ----------------------------------------------------------

/**
 * Берём первые SF_BEST_LINE_PLIES ходов из sfBestPv (UCI) и переводим
 * в SAN, симулируя их на fenBefore. Возвращаем пустой массив при любой
 * ошибке.
 */
function buildSfBestLine(fenBefore: string, pv: string[]): string[] {
  if (pv.length === 0) return [];
  let c: Chess;
  try {
    c = new Chess(fenBefore);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const uci of pv.slice(0, SF_BEST_LINE_PLIES)) {
    if (uci.length < 4) break;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    try {
      const mv = c.move({ from, to, promotion });
      if (!mv) break;
      out.push(mv.san);
    } catch {
      break;
    }
  }
  return out;
}

// --- main ------------------------------------------------------------------

export function extractFacts(input: ExtractFactsInput): FactsInput {
  const side = sideFromFen(input.fenBefore);
  const move = parsePlayedMove(
    input.fenBefore,
    input.playedUci,
    input.playedSan,
  );

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

  const isBestMove = input.playedUci === input.sfData.bestUci;
  const sf_best: FactsSfBest | null = isBestMove
    ? null
    : {
        uci: input.sfData.bestUci,
        san: input.sfData.bestSan,
        line: buildSfBestLine(input.fenBefore, input.sfData.sfBestPv),
      };

  // --- мотивы / угрозы — нужны два Chess (до/после) ---
  let cBefore: Chess | null = null;
  let cAfter: Chess | null = null;
  try {
    cBefore = new Chess(input.fenBefore);
  } catch {
    cBefore = null;
  }
  try {
    cAfter = new Chess(input.fenAfter);
  } catch {
    cAfter = null;
  }

  let tactical_motifs: TacticalMotif[] = [];
  let threats_created: ThreatsCreated = {};
  let threats_missed: ThreatsMissed = {};
  if (cBefore && cAfter) {
    const fromSquare = input.playedUci.slice(0, 2) as Square;
    tactical_motifs = detectMotifs(cBefore, cAfter, side, fromSquare);
    threats_created = buildThreatsCreated(
      cBefore,
      cAfter,
      side,
      input.sfData.mateAfter,
    );
    if (!isBestMove) {
      threats_missed = buildThreatsMissed(
        input.fenBefore,
        input.sfData.bestUci,
        threats_created,
        side,
        // mateAfterBest нам не известен по входу (бэк подсчёта нет);
        // консервативно — null. Если реальный ход не матует, а лучший
        // — матует, threats_missed.mate_in поднимется через mateAfter
        // эталона на бэке (B1) при необходимости.
        null,
      );
    }
  }

  let maia_alternative: FactsMaiaAlternative | null = null;
  const maiaTopUci = input.maiaData.maiaTopUci;
  const maiaSameAsBest = maiaTopUci === input.sfData.bestUci;
  const maiaSameAsPlayed = maiaTopUci === input.playedUci;
  if (maiaTopUci && !maiaSameAsBest && !maiaSameAsPlayed) {
    const maiaSan = uciToSan(input.fenBefore, maiaTopUci);
    const maiaWdlAfter = input.maiaData.wdlAfterMaiaTop;
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
    fen_after: input.fenAfter,
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
    tactical_motifs,
    threats_created,
    threats_missed,
    positional_shifts: [],
    positional_subterms: input.positionalSubterms ?? [],
    user_elo: input.userElo,
    user_language: input.userLanguage,
  };
}
