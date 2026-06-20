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

// KS-4368 / KS-4367. `TacticPuzzleObjective` удалён: семантика «реализуй
// перевес / удержи равенство» оказалась ad-hoc эвристикой, не отражённой
// в реальном UI и плохо коррелирующей с ощущением сложности у игрока
// (см. пересмотр ADR-135 §2.3, коммит f8fa746). Поле `objective` уходит
// из всех контрактов и из колонки БД на T1.

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
  /** Только пазлы с `difficulty >= maiaDifficultyMin`. */
  maiaDifficultyMin?: number;
  /** Только пазлы с `gap >= gapMin`. */
  gapMin?: number;
  ratingMin?: number;
  ratingMax?: number;
  themes?: string[];
  /** KS-4365. Фильтр по тому, решал ли текущий пользователь:
   *  `true` — только решённые (есть `tactic_puzzle_attempts.solved=true`);
   *  `false` — только нерешённые этим пользователем;
   *  не задан — все. Для гостя параметр игнорируется (без 400).
   */
  solved?: boolean;
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
  themes: string[];
  /** ISO-8601 — когда ошибка добавлена. */
  createdAt: string;
}

export interface TacticUserMistakesPage {
  items: TacticUserMistakeItem[];
  nextCursor: string | null;
}

// ─── KS-4355 / ADR-136 §3.7 — история и статистика ──────────────────

/**
 * Алиас на `TacticPuzzleStopReason` без префикса `Puzzle` — используется
 * в API истории и статистики (`/tactic-puzzles/attempts`, `/stats/*`).
 * Семантика и набор значений идентичны.
 */
export type TacticStopReason = TacticPuzzleStopReason;

/**
 * Элемент списка истории попыток (`GET /tactic-puzzles/attempts`).
 * Поля сжаты до того, что нужно UI-карточке: мини-доска (FEN +
 * bestMoveUci + solverSide), заголовок партии-источника
 * (`playersTitle` = `"White Player vs Black Player"`), метрика
 * успеха (solved + stopReason), затраченное время и линия, дельта
 * рейтинга для индикатора «-7 / +12».
 */
export interface TacticAttemptListItem {
  id: string;
  puzzleId: string;
  fen: string;
  bestMoveUci: string;
  solverSide: 'w' | 'b';
  /** Заголовок партии-источника, формат `"White vs Black"` либо
   *  `null` если пазл не из партии или ELO не подтверждены. */
  playersTitle: string | null;
  solved: boolean;
  stopReason: TacticStopReason;
  lineHalfMoves: number;
  timeMs: number;
  ratingBefore: number;
  ratingAfter: number;
  /** `ratingAfter − ratingBefore`. Денормализованный кэш для UI. */
  ratingDelta: number;
  precisionGrade: number | null;
  /** ISO-8601. */
  createdAt: string;
}

export interface TacticAttemptListPage {
  items: TacticAttemptListItem[];
  nextCursor: string | null;
}

/**
 * Детали одной попытки (`GET /tactic-puzzles/attempts/:id`). Расширяет
 * `TacticAttemptListItem` полями для разбора:
 *   * `userMoves` — все ходы пользователя через пробел (UCI), для
 *     перевоспроизведения на доске;
 *   * `wdlStart` / `wdlEnd` — expected-score solver'а на старте и в
 *     конце попытки (snapshot, не пересчитываем);
 *   * `movesAccuracy` — точность по ходам [0..1] (если считалось);
 *   * `puzzle` — компактная ссылка на пазл (FEN, темы, метрики);
 *   * `sourceGameId` / `sourceHeaders` — данные партии-источника для
 *     карточки «из партии» внутри разбора.
 */
export interface TacticAttemptDetail extends TacticAttemptListItem {
  userMoves: string;
  wdlStart: number | null;
  wdlEnd: number | null;
  movesAccuracy: number | null;
  puzzle: {
    id: string;
    fen: string;
    bestMoveUci: string;
    difficulty: number;
    gap: number;
    rating: number;
    themes: string[];
  };
  sourceGameId: string | null;
  sourceMoveNum: number | null;
  sourceHeaders: Record<string, string> | null;
}

/**
 * Агрегированная статистика пользователя по разделу «Точность»
 * (`GET /tactic-puzzles/stats/me`). Все агрегаты рассчитываются
 * на лету по `tactic_puzzle_attempts` + `user_tactic_ratings`
 * (см. ADR-136 §3.5). Materialized view не нужны на этапе MVP.
 *
 * `difficultyBuckets` — гистограмма принятых попыток по интервалам
 * Maia-difficulty: ключ — диапазон `"0.9-0.95"` / `"0.95-1.0"` (точные
 * границы выбирает сервис); значение — счётчик попыток в нём.
 */
export interface TacticUserStats {
  rating: {
    value: number;
    deviation: number;
    attempts: number;
    /** ISO-8601 или `null` для пользователя без единой попытки. */
    lastAttemptAt: string | null;
  };
  totals: {
    attempts: number;
    solved: number;
    /** `solved / attempts * 100`, округление до целого. 0 при attempts=0. */
    solvedPercent: number;
    avgTimeMs: number;
    avgLineHalfMoves: number;
    avgPrecisionGrade: number | null;
  };
  streak: {
    /** Сколько подряд solved-попыток В САМОМ ПОСЛЕДНЕМ хвосте истории. */
    current: number;
    /** Личный рекорд за всё время. */
    best: number;
  };
  stopReasonBreakdown: Record<TacticStopReason, number>;
  difficultyBuckets: Record<string, number>;
}

/**
 * Точка графика динамики рейтинга (`GET /tactic-puzzles/stats/rating-history`).
 * Источник — таблица `tactic_rating_snapshots` (см. KS-4354 / ADR-136 §3.6).
 * Дни без попыток пропускаются — фронт линейно соединит точки сам.
 */
export interface TacticRatingPoint {
  /** `YYYY-MM-DD` (без времени, UTC-день из БД-колонки `date`). */
  date: string;
  rating: number;
  /** Сколько попыток сделано в этот день (для tooltip'а на точке). */
  attempts: number;
  /** Сколько из них solved. */
  solved: number;
}

/**
 * Элемент журнала ошибок (`GET /tactic-puzzles/mistakes`, новая форма
 * по ADR-136). Отличие от существующего `TacticUserMistakeItem` —
 * `playersTitle` и `stopReason` последней попытки: UI «работа над
 * ошибками» показывает, чем кончилась попытка, и партию-источник.
 *
 * Существующий `TacticUserMistakeItem` оставлен для обратной
 * совместимости с уже задеплоенным `GET /mistakes` (ADR-135 §2.4);
 * новый тип используется только в обновлённой ветке.
 */
export interface TacticMistakeListItem {
  id: string;
  puzzleId: string;
  /** FEN стартовой позиции для мини-доски в карточке. */
  fen: string;
  bestMoveUci: string;
  solverSide: 'w' | 'b';
  themes: string[];
  difficulty: number;
  /** Заголовок партии-источника, формат `"White vs Black"` либо `null`. */
  playersTitle: string | null;
  /** `stopReason` последней попытки этого пазла (что именно не получилось). */
  lastStopReason: TacticStopReason | null;
  resolved: boolean;
  /** ISO-8601 — когда ошибка добавлена в журнал. */
  createdAt: string;
}

export interface TacticMistakeListPage {
  items: TacticMistakeListItem[];
  nextCursor: string | null;
}
