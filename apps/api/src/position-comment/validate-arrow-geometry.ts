/**
 * KS-4069. Геометрическая валидация overlay-стрелок.
 *
 * Модель в системной инструкции уже обязана рисовать стрелки только
 * от атакующей фигуры к её цели. На практике это правило регулярно
 * нарушается: жалоба пользователя из задачи KS-4069 показывает
 * стрелку от слона c4 на h6, хотя клетки даже не на одной диагонали,
 * а в реальной позиции — диагональ ещё и заблокирована.
 *
 * Эта чистая функция фильтрует стрелки на стороне backend: стрелка
 * S → T оставляется только если фигура на S реально атакует/защищает
 * T в текущей позиции (с учётом дальности, типа фигуры, блокирующих
 * фигур) — либо это легальное движение пешки вперёд на 1/2 клетки.
 *
 * Используется в `parseModelOutput(raw, fen)` (см. parse-model-output.ts).
 * Без `fen` валидация пропускается — нужно для обратной совместимости
 * с unit-тестами модуля разбора.
 */
import { Chess, type Color, type Square } from 'chess.js';

const SQUARE_RE = /^[a-h][1-8]$/;

/**
 * @returns true — стрелка от `from` к `to` валидна в позиции `fen`.
 *          false — фигура на `from` не атакует/не ходит на `to`,
 *          или входные данные некорректны (битая клетка, пустая from,
 *          битый FEN).
 */
export function isArrowGeometryValid(
  from: string,
  to: string,
  fen: string,
): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  if (!SQUARE_RE.test(from) || !SQUARE_RE.test(to)) return false;
  if (from === to) return false;

  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return false;
  }

  const piece = chess.get(from as Square);
  if (!piece) return false;

  // 1) Атака / защита: from среди клеток, фигуры с которых атакуют to
  //    фигурами цвета `piece.color`. `attackers` chess.js учитывает
  //    тип фигуры, дальность и блокирующие фигуры. Это покрывает все
  //    обычные ходы-захваты, защиту своих фигур, атаку пустой клетки
  //    для не-пешек.
  try {
    const attackers = chess.attackers(to as Square, piece.color);
    if (Array.isArray(attackers) && attackers.includes(from as Square)) {
      return true;
    }
  } catch {
    // некоторые FEN-комбинации могут бросить — считаем неуспехом и
    // переходим к следующей проверке.
  }

  // 2) Пешечный ход вперёд (1 или 2 клетки) — `attackers` его не
  //    покроет, потому что пешка атакует только по диагонали. Стрелка
  //    типа e2 → e4 в начальной позиции — типичный «лучший ход» от
  //    модели, и его надо считать валидным.
  if (piece.type === 'p') {
    return isPawnPush(from, to, piece.color, chess);
  }

  return false;
}

function isPawnPush(
  from: string,
  to: string,
  color: Color,
  chess: Chess,
): boolean {
  if (from[0] !== to[0]) return false; // взятие по диагонали — это атака
  const rankFrom = parseInt(from[1], 10);
  const rankTo = parseInt(to[1], 10);
  const dir = color === 'w' ? 1 : -1;
  const startRank = color === 'w' ? 2 : 7;
  const diff = rankTo - rankFrom;

  if (diff === dir) {
    // 1 клетка: цель должна быть пуста
    return !chess.get(to as Square);
  }
  if (diff === 2 * dir && rankFrom === startRank) {
    // 2 клетки: и промежуточная, и цель должны быть пусты
    const middle = `${from[0]}${rankFrom + dir}` as Square;
    return !chess.get(middle) && !chess.get(to as Square);
  }
  return false;
}
