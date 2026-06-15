/**
 * KS-4141 / ADR-128 §6.9. Локальный «офлайн» движок blind-board для
 * гостей. Backend для гостя возвращает 204 (`POST /blind-board/sessions*`
 * PF write по §11.13), что ломает фронт: `Response.json()` на пустом
 * теле бросает SyntaxError. Концепт ADR-128 — гость работает локально,
 * без сетевых запросов. Этот файл — минимальный engine, достаточный
 * чтобы гость мог пройти несколько раундов.
 *
 * Что реализовано
 * - startSession: расставляет `config.startPieces` случайно по пустой
 *   доске, выбирает рандомный первый ход фигуры из её geometricMoves.
 * - submitAnswer: сверяет ответ против запомненной фигуры компа
 *   (клетка ДО хода + тип); при совпадении делает компу ход, выбирает
 *   следующего, инкрементирует streak/round; при ошибке завершает
 *   сессию с `finishReason='wrong-answer'` и раскрывает позицию.
 * - getLeaderboard / getSession / deleteSession: для гостя возвращают
 *   пустые или фейковые данные (см. ниже).
 *
 * Что НЕ реализовано (упрощения)
 * - Прогрессия (level-up по `addOrder`). У гостя `level` всегда 1.
 *   Бэк добавляет фигуры на доску в режиме `progressionEnabled=true`;
 *   локально это лишняя сложность для MVP, отложено.
 * - Уникальность вовлечённой фигуры (KS-3451 novelty filter). Бэк
 *   через `findUniqueTargetMoves` фильтрует ходы, чтобы ровно одна
 *   фигура была «новая» в позиции после хода. Локально мы берём
 *   любой геометрически легальный ход — это даст играбельность, но
 *   с упрощённой механикой по сравнению с авторизованным режимом.
 *
 * State хранится в module-scope Map по sessionId. Живёт до перезагрузки
 * вкладки — для гостя этого достаточно (сессия не должна переживать
 * reload, см. ADR-128 §8).
 */
import type {
  BlindBoardConfig,
  BlindBoardFinishReason,
  BlindBoardMove,
  BlindBoardPiece,
  BlindBoardPieceType,
  BlindBoardSessionDto,
  BlindBoardSquare,
  StartBlindBoardSessionRequest,
  StartBlindBoardSessionResponse,
  SubmitBlindBoardAnswerRequest,
  SubmitBlindBoardAnswerResponse,
  BlindBoardLeaderboardResponse,
  BlindBoardSessionReviewResponse,
} from '@kingside/shared';
import { DEFAULT_BLIND_BOARD_CONFIG, geometricMoves } from '@kingside/shared';

const FILES = 'abcdefgh';
const ALL_SQUARES: BlindBoardSquare[] = (() => {
  const out: BlindBoardSquare[] = [];
  for (const f of FILES) {
    for (let r = 1; r <= 8; r++) {
      out.push(`${f}${r}` as BlindBoardSquare);
    }
  }
  return out;
})();

interface GuestSessionState {
  id: string;
  startedAt: string;
  config: BlindBoardConfig;
  position: BlindBoardPiece[];
  round: number;
  streak: number;
  bestStreak: number;
  /** Фигура, которая делает текущий ход компа (ожидаемый ответ). */
  expected: BlindBoardPiece | null;
  /** Куда фигура переедет, если игрок угадает. */
  nextTo: BlindBoardSquare | null;
  status: 'active' | 'finished';
  finishReason: BlindBoardFinishReason | null;
  finishedAt: string | null;
}

const STATE = new Map<string, GuestSessionState>();

function randomId(): string {
  // crypto.randomUUID — есть во всех современных браузерах и в Node 19+.
  // На случай экзотики — fallback на Math.random.
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as { randomUUID: () => string }).randomUUID();
    }
  } catch {
    /* ignore */
  }
  return (
    'guest-' +
    Math.random().toString(36).slice(2, 10) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

function pickRandom<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildStartPosition(pieces: BlindBoardPieceType[]): BlindBoardPiece[] {
  // KS-3449 follow-up: для двух слонов backend гарантирует
  // разнопольность. Локально пропускаем эту проверку — гостевой режим
  // упрощён, лишний шум в коде не оправдан для MVP.
  const squares = shuffle(ALL_SQUARES).slice(0, pieces.length);
  return pieces.map((type, i) => ({ square: squares[i], type }));
}

function pickCompMove(
  position: BlindBoardPiece[],
): { piece: BlindBoardPiece; to: BlindBoardSquare } | null {
  // Шафлим фигуры и ищем у первой, у кого есть хоть один легальный
  // ход. Это даёт некоторую вариативность кадра.
  for (const piece of shuffle(position)) {
    const moves = geometricMoves(piece, position);
    if (moves.length > 0) {
      return { piece, to: pickRandom(moves) };
    }
  }
  return null;
}

function makeDto(state: GuestSessionState): BlindBoardSessionDto {
  return {
    id: state.id,
    status: state.status,
    finishReason: state.finishReason,
    round: state.round,
    streak: state.streak,
    bestStreak: state.bestStreak,
    level: 1,
    nextMove:
      state.expected && state.nextTo
        ? { from: state.expected.square, to: state.nextTo }
        : null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

export function isGuest(): boolean {
  return typeof window !== 'undefined' && !localStorage.getItem('token');
}

export function startGuestSession(
  body?: StartBlindBoardSessionRequest,
): StartBlindBoardSessionResponse {
  const config = body?.config ?? DEFAULT_BLIND_BOARD_CONFIG;
  const position = buildStartPosition(config.startPieces);
  const first = pickCompMove(position);
  const now = new Date().toISOString();
  const id = randomId();
  const state: GuestSessionState = {
    id,
    startedAt: now,
    config,
    position,
    round: 1,
    streak: 0,
    bestStreak: 0,
    expected: first ? first.piece : null,
    nextTo: first ? first.to : null,
    status: 'active',
    finishReason: null,
    finishedAt: null,
  };
  STATE.set(id, state);
  return {
    session: makeDto(state),
    startPosition: [...position],
    level: 1,
    config,
  };
}

export function submitGuestAnswer(
  sessionId: string,
  body: SubmitBlindBoardAnswerRequest,
): SubmitBlindBoardAnswerResponse {
  const state = STATE.get(sessionId);
  if (!state) {
    // Сессия не найдена в локальном кеше (например, после reload).
    // Имитируем «уже финиширована, ответ не принят».
    const now = new Date().toISOString();
    const fakeId = sessionId || randomId();
    return {
      correct: false,
      session: {
        id: fakeId,
        status: 'finished',
        finishReason: 'abandoned',
        round: 1,
        streak: 0,
        bestStreak: 0,
        level: 1,
        nextMove: null,
        startedAt: now,
        finishedAt: now,
      },
    };
  }
  if (state.status === 'finished' || !state.expected || !state.nextTo) {
    return { correct: false, session: makeDto(state) };
  }
  const expected = state.expected;
  const correct =
    body.square === expected.square && body.pieceType === expected.type;
  if (!correct) {
    state.status = 'finished';
    state.finishReason = 'wrong-answer';
    state.finishedAt = new Date().toISOString();
    const revealed = [...state.position];
    state.expected = null;
    state.nextTo = null;
    return {
      correct: false,
      expectedSquare: expected.square,
      expectedPieceType: expected.type,
      revealedPosition: revealed,
      session: makeDto(state),
    };
  }
  // Правильный ответ: фигура реально переезжает на nextTo.
  const others = state.position.filter((p) => p.square !== expected.square);
  state.position = [
    ...others,
    { square: state.nextTo, type: expected.type },
  ];
  state.streak += 1;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.round += 1;
  const next = pickCompMove(state.position);
  if (!next) {
    state.status = 'finished';
    state.finishReason = 'dead-end';
    state.finishedAt = new Date().toISOString();
    state.expected = null;
    state.nextTo = null;
  } else {
    state.expected = next.piece;
    state.nextTo = next.to;
  }
  return { correct: true, session: makeDto(state) };
}

export function getGuestLeaderboard(): BlindBoardLeaderboardResponse {
  // У гостя нет аккаунта — лидерборд пустой.
  return { entries: [] };
}

export function getGuestSession(
  sessionId: string,
): BlindBoardSessionReviewResponse {
  const state = STATE.get(sessionId);
  if (!state) {
    // Backend на чужую/несуществующую сессию отвечает 404. В клиенте
    // нет авторизованного помощника, проще вернуть пустую финализацию.
    const now = new Date().toISOString();
    return {
      session: {
        id: sessionId,
        status: 'finished',
        finishReason: 'abandoned',
        round: 1,
        streak: 0,
        bestStreak: 0,
        level: 1,
        nextMove: null,
        startedAt: now,
        finishedAt: now,
      },
      config: DEFAULT_BLIND_BOARD_CONFIG,
      attempts: [],
    };
  }
  return {
    session: makeDto(state),
    config: state.config,
    attempts: [],
    startPosition:
      state.status === 'finished' ? [...state.position] : undefined,
  };
}

export function deleteGuestSession(sessionId: string): void {
  STATE.delete(sessionId);
}

// Экспорт типа compMove для удобства тестирования.
export type { GuestSessionState };

// Очистка для unit-тестов (не используется в проде).
export function _resetGuestState(): void {
  STATE.clear();
}

// Утилита для тестов: получить полную позицию сессии (бэкенд не отдаёт
// клиенту, но локально мы её знаем).
export function _peekGuestPosition(sessionId: string): BlindBoardPiece[] | null {
  const s = STATE.get(sessionId);
  return s ? [...s.position] : null;
}

// Хелпер: какой именно ответ ожидается на текущем раунде (для тестов).
export function _peekGuestExpected(
  sessionId: string,
): { square: BlindBoardSquare; pieceType: BlindBoardPieceType } | null {
  const s = STATE.get(sessionId);
  if (!s || !s.expected) return null;
  return { square: s.expected.square, pieceType: s.expected.type };
}

// Утилита: только для UI-debug.
export function _guestMove(sessionId: string): BlindBoardMove | null {
  const s = STATE.get(sessionId);
  if (!s || !s.expected || !s.nextTo) return null;
  return { from: s.expected.square, to: s.nextTo };
}
