/**
 * KS-4981 / ADR-167 §2, §4: генераторы и валидаторы челленджей Vision-тренажёра.
 *
 * Геометрия (relation/geometry) считается на `utils/blind-board/move-gen.ts`
 * (`attacks`, `parseSquare`, `makeSquare`) — новый движок не вводится
 * (ADR-167 §4, §8). Цвет — `isDarkSquare` (чистая чётность).
 *
 * `rng: () => number` (значение из [0,1)) инъектируется ради
 * детерминированности в тестах; по умолчанию `Math.random`.
 */
import type {
  BlindBoardPiece,
  BlindBoardPieceType,
  BlindBoardSquare,
} from '../../types/api-contracts.js';
import type {
  VisionChallenge,
  VisionColorChallenge,
  VisionConcreteMode,
  VisionFindChallenge,
  VisionGeometryChallenge,
  VisionNameChallenge,
  VisionRelationChallenge,
  VisionRelationKind,
} from '../../types/vision.js';
import { attacks, makeSquare, parseSquare } from '../blind-board/move-gen.js';
import { isDarkSquare, squareColor } from './is-dark-square.js';

export type VisionRng = () => number;

const PIECE_TYPES: readonly BlindBoardPieceType[] = ['N', 'B', 'R', 'Q'];
const RELATION_KINDS: readonly VisionRelationKind[] = [
  'diagonal',
  'file',
  'rank',
  'color',
];
const CONCRETE_MODES: readonly VisionConcreteMode[] = [
  'color',
  'find',
  'name',
  'relation',
  'geometry',
];

// --- Примитивы истины (validators) -----------------------------------------

/**
 * Атакует ли фигура `type` с клетки `from` клетку `target` на пустой доске.
 * Использует `attacks` из move-gen: единственная фигура позиции — сама она,
 * лучи идут до края доски (ADR-167 §4).
 */
export function pieceAttacksSquare(
  type: BlindBoardPieceType,
  from: BlindBoardSquare,
  target: BlindBoardSquare,
): boolean {
  const piece: BlindBoardPiece = { square: from, type };
  return attacks(piece, [piece]).has(target);
}

/** Верно ли, что `a` и `b` состоят в отношении `kind`. `a===b` → `false`. */
export function computeRelation(
  a: BlindBoardSquare,
  b: BlindBoardSquare,
  kind: VisionRelationKind,
): boolean {
  if (a === b) return false;
  const [fa, ra] = parseSquare(a);
  const [fb, rb] = parseSquare(b);
  switch (kind) {
    case 'file':
      return fa === fb;
    case 'rank':
      return ra === rb;
    case 'diagonal':
      return Math.abs(fa - fb) === Math.abs(ra - rb);
    case 'color':
      return isDarkSquare(a) === isDarkSquare(b);
  }
}

/**
 * Проверка внутренней корректности челленджа: пересчитывает ожидаемый ответ
 * из примитивов и сравнивает с сохранённым `answer`. `true` — челлендж
 * согласован (генератор корректен).
 */
export function validateChallenge(ch: VisionChallenge): boolean {
  switch (ch.mode) {
    case 'color':
      return ch.answer === squareColor(ch.square);
    case 'find':
    case 'name':
      return ch.answer === ch.square;
    case 'relation':
      return ch.answer === computeRelation(ch.a, ch.b, ch.relation);
    case 'geometry':
      return ch.answer === pieceAttacksSquare(ch.piece, ch.from, ch.target);
  }
}

/** Проверка ответа пользователя: сравнение со значением `answer`. */
export function checkAnswer(
  ch: VisionChallenge,
  value: string | boolean,
): boolean {
  return value === ch.answer;
}

// --- Утилиты RNG -----------------------------------------------------------

function pick<T>(arr: readonly T[], rng: VisionRng): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Случайная клетка a1..h8. */
export function randomSquare(rng: VisionRng = Math.random): BlindBoardSquare {
  const f = Math.floor(rng() * 8);
  const r = Math.floor(rng() * 8);
  // makeSquare для 0..7 всегда возвращает валидную клетку.
  return makeSquare(f, r) as BlindBoardSquare;
}

function randomSquareExcept(
  except: BlindBoardSquare,
  rng: VisionRng,
): BlindBoardSquare {
  let sq = randomSquare(rng);
  while (sq === except) sq = randomSquare(rng);
  return sq;
}

// --- Генераторы челленджей --------------------------------------------------

export function generateColorChallenge(
  rng: VisionRng = Math.random,
): VisionColorChallenge {
  const square = randomSquare(rng);
  return { mode: 'color', square, answer: squareColor(square) };
}

export function generateFindChallenge(
  rng: VisionRng = Math.random,
): VisionFindChallenge {
  const square = randomSquare(rng);
  return { mode: 'find', square, answer: square };
}

export function generateNameChallenge(
  rng: VisionRng = Math.random,
): VisionNameChallenge {
  const square = randomSquare(rng);
  return { mode: 'name', square, answer: square };
}

/**
 * Отношение двух клеток. С вероятностью ~0.5 строим `b`, удовлетворяющую
 * `relation` (позитивный пример), иначе — произвольную (ответ вычисляется).
 * Так распределение Да/Нет не вырождается в почти-всегда-«Нет».
 */
export function generateRelationChallenge(
  rng: VisionRng = Math.random,
): VisionRelationChallenge {
  const relation = pick(RELATION_KINDS, rng);
  const a = randomSquare(rng);
  const wantPositive = rng() < 0.5;
  const b = wantPositive
    ? buildRelated(a, relation, rng)
    : randomSquareExcept(a, rng);
  return { mode: 'relation', a, b, relation, answer: computeRelation(a, b, relation) };
}

/** Строит клетку, состоящую в отношении `kind` с `a` (fallback — random). */
function buildRelated(
  a: BlindBoardSquare,
  kind: VisionRelationKind,
  rng: VisionRng,
): BlindBoardSquare {
  const [fa, ra] = parseSquare(a);
  const candidates: BlindBoardSquare[] = [];
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const sq = makeSquare(f, r) as BlindBoardSquare;
      if (sq === a) continue;
      let ok = false;
      switch (kind) {
        case 'file': ok = f === fa; break;
        case 'rank': ok = r === ra; break;
        case 'diagonal': ok = Math.abs(f - fa) === Math.abs(r - ra); break;
        case 'color': ok = (f + r) % 2 === (fa + ra) % 2; break;
      }
      if (ok) candidates.push(sq);
    }
  }
  if (candidates.length === 0) return randomSquareExcept(a, rng);
  return pick(candidates, rng);
}

/**
 * Геометрия фигуры. С вероятностью ~0.5 берём `target` из множества атак
 * (позитив), иначе — из не-атакуемых клеток (негатив). Множество атак на
 * пустой доске непусто для всех 4 фигур, множество не-атак тоже.
 */
export function generateGeometryChallenge(
  rng: VisionRng = Math.random,
): VisionGeometryChallenge {
  const piece = pick(PIECE_TYPES, rng);
  const from = randomSquare(rng);
  const attacked = attacks({ square: from, type: piece }, [{ square: from, type: piece }]);
  const attackedList = [...attacked];
  const notAttacked: BlindBoardSquare[] = [];
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const sq = makeSquare(f, r) as BlindBoardSquare;
      if (sq !== from && !attacked.has(sq)) notAttacked.push(sq);
    }
  }
  const wantPositive = rng() < 0.5 && attackedList.length > 0;
  const pool = wantPositive ? attackedList : notAttacked;
  const target = pool.length > 0 ? pick(pool, rng) : attackedList[0];
  return {
    mode: 'geometry',
    piece,
    from,
    target,
    answer: attacked.has(target),
  };
}

/** Генератор конкретного режима. */
export function generateChallengeForMode(
  mode: VisionConcreteMode,
  rng: VisionRng = Math.random,
): VisionChallenge {
  switch (mode) {
    case 'color': return generateColorChallenge(rng);
    case 'find': return generateFindChallenge(rng);
    case 'name': return generateNameChallenge(rng);
    case 'relation': return generateRelationChallenge(rng);
    case 'geometry': return generateGeometryChallenge(rng);
  }
}

/**
 * Главная точка входа. `mode==='mixed'` → случайный конкретный режим,
 * иначе — заданный. Ответ челленджа всегда согласован (`validateChallenge`).
 */
export function generateChallenge(
  mode: VisionConcreteMode | 'mixed',
  rng: VisionRng = Math.random,
): VisionChallenge {
  const concrete = mode === 'mixed' ? pick(CONCRETE_MODES, rng) : mode;
  return generateChallengeForMode(concrete, rng);
}
