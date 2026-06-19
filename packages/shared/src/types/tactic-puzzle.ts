/**
 * KS-4342 / ADR-135 §2.4. API-контракты раздела «Точность»
 * (`/tactic-puzzles/*`). Единый источник истины для backend (api/
 * tactic-puzzle) и frontend (TacticPuzzleRunner / api-tactic-puzzle).
 *
 * Намеренно изолировано от `puzzle.ts` / `api-contracts.ts` старого
 * /puzzles — концепт принципиально другой (см. ADR-135 §1):
 *   * нет `solutionMode`, `puzzlePhase`, `reactive`/`preventive`,
 *     `acceptedMoves`, `moves` — у tactic-пазла длина решения
 *     переменная и определяется клиентом во время игры;
 *   * `bestMoveUci` — единственный сильный ход на стартовой FEN
 *     (один правильный ход, дальше клиент сам пересчитывает
 *     сложность через shared `analyzePlyForTacticPuzzle`);
 *   * `stopReason` отражает причину завершения попытки
 *     (`easy` — сложность упала, пользователь нажал «завершить»;
 *      `mate` — мат/пат; `mistake` — сыграл не bestMove;
 *      `timeout` — таймер; `aborted` — закрыл / прервал).
 */

/** Семантика задачи solver'у. */
export type TacticPuzzleObjective = 'convertAdvantage' | 'saveEquality';

/** Причина закрытия попытки в `tactic_puzzle_attempts.stop_reason`. */
export type TacticPuzzleStopReason =
  | 'easy'
  | 'mate'
  | 'mistake'
  | 'timeout'
  | 'aborted';

/**
 * Per-mille WDL (POV solver) для отображения в UI и telemetry.
 * Сумма ≈ 1000, округление допускает ±1.
 */
export interface TacticPuzzleWdl {
  w: number;
  d: number;
  l: number;
}

/**
 * Один пазл в формате, который отдаёт API (`/next`, `/:id`, `/browse`).
 * Метрики качества (`bestE`, `gap`, `difficulty`) пробрасываются на UI
 * для индикатора сложности и фильтров (`maiaDifficultyMin`, `gapMin`).
 */
export interface TacticPuzzleResponse {
  id: string;
  fen: string;
  /** UCI единственного сильного хода (решение пазла). */
  bestMoveUci: string;
  /** side-to-move в `fen` — кто решает. */
  solverSide: 'w' | 'b';
  objective: TacticPuzzleObjective;
  themes: string[];
  rating: number;
  ratingDev: number;
  difficulty: number;
  gap: number;
  bestE: number;
  secondE: number;
  wdl: TacticPuzzleWdl;
  /** ISO-8601. */
  createdAt: string;
  /** Заголовки PGN (Seven Tag Roster + ELO) — UI «из партии». */
  sourceHeaders: Record<string, string> | null;
  sourceMoveNum: number | null;
  sourceGameId: string | null;
}

/**
 * Параметры запроса `GET /tactic-puzzles/browse`. Все опциональны.
 * `cursor` — opaque-токен для пагинации (выдаётся с прошлым ответом).
 */
export interface TacticPuzzleBrowseQuery {
  cursor?: string;
  limit?: number;
  objective?: TacticPuzzleObjective;
  /** Только пазлы с `difficulty >= maiaDifficultyMin`. */
  maiaDifficultyMin?: number;
  /** Только пазлы с `gap >= gapMin`. */
  gapMin?: number;
  ratingMin?: number;
  ratingMax?: number;
  themes?: string[];
}

export interface TacticPuzzleBrowsePage {
  items: TacticPuzzleResponse[];
  nextCursor: string | null;
}

/**
 * Тело `POST /tactic-puzzles/:id/attempts`. Клиент собирает поля во
 * время игры, поэтому здесь — итоговые значения на момент закрытия
 * попытки (см. ADR-135 §2.3 для семантики переменной длины линии).
 */
export interface SubmitTacticAttemptInput {
  /** Число полуходов пользователя (≥ 0). */
  lineHalfMoves: number;
  /** Все ходы пользователя через пробел (UCI). */
  userMoves: string;
  /** Причина закрытия попытки. */
  stopReason: TacticPuzzleStopReason;
  /** Время с начала попытки (ms). */
  timeMs: number;
  /** Стартовое expected-score решающего (snapshot). */
  wdlStart?: number | null;
  /** Финальное expected-score решающего. */
  wdlEnd?: number | null;
  /** Точность ходов (0..1) — серверный пересчёт необязателен. */
  movesAccuracy?: number | null;
  /** 1..5 stars (ADR-065). */
  precisionGrade?: number | null;
}

/**
 * Ответ `POST /tactic-puzzles/:id/attempts`. Возвращаем все
 * рейтинг-эффекты (для UI «было/стало») и idemportency-маркер,
 * чтобы клиент не записал двойную попытку при ретрае.
 */
export interface SubmitTacticAttemptResponse {
  attemptId: string;
  solved: boolean;
  ratingBefore: number;
  ratingAfter: number;
  puzzleRatingBefore: number;
  puzzleRatingAfter: number;
  /** Пазл попал в журнал ошибок (mistake/timeout/aborted при unsolved). */
  addedToMistakes: boolean;
}

/**
 * Запись в журнале «работа над ошибками» (`GET /tactic-puzzles/mistakes`).
 */
export interface TacticUserMistakeItem {
  id: string;
  puzzleId: string;
  fen: string;
  bestMoveUci: string;
  rating: number;
  difficulty: number;
  gap: number;
  objective: TacticPuzzleObjective;
  themes: string[];
  /** ISO-8601 — когда ошибка добавлена. */
  createdAt: string;
}

export interface TacticUserMistakesPage {
  items: TacticUserMistakeItem[];
  nextCursor: string | null;
}
