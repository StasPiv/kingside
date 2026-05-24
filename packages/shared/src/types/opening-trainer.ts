/**
 * KS-3269 (ADR-077). Shared types для Opening Trainer — тренировка
 * дебютов из пользовательского PGN.
 *
 * Контракт между:
 *   - backend (`apps/api/src/opening-trainer/*` — controller, service, DTO)
 *   - frontend (`apps/web/src/pages/opening-trainer/*`, hooks)
 *
 * Источник истины — ADR-077 §3 (RepertoireTree), §6 (12 endpoints).
 * Семантические правила (бот-picker, скоринг, мастеринг) описаны в
 * §2.3 / §2.7 / §2.5 ADR'а и здесь только как константы.
 */

// ─── Enum-style unions ─────────────────────────────────────────────────

/** Цвет фигур пользователя в сессии (бот играет другим цветом). */
export type TrainerColor = 'white' | 'black';

/**
 * Режим тренировки:
 *   - `learn`     — учим новые линии (без SM-2, до 3 подряд правильных = mastered)
 *   - `review`    — SRS по линиям с `sm2DueAt <= now` (M2)
 *   - `mistakes`  — только линии, где `wrongCount > 0`
 *   - `free`      — свободная прогонка по всему репертуару, без обновления статистики
 */
export type OpeningTrainerMode = 'learn' | 'review' | 'mistakes' | 'free';

/**
 * Что делать когда в позиции пройдены все edges:
 *   - `cycle`    — обнуляем `playedLines[fen]` и продолжаем
 *   - `complete` — финиш сессии (default для M1)
 */
export type OpeningTrainerRepeatMode = 'cycle' | 'complete';

/** Статус сессии для UX. */
export type OpeningTrainerSessionStatus = 'active' | 'finished' | 'expired';

/**
 * Результат проверки хода пользователя.
 *
 * KS-3277 расширение для «учить дерево до полного освоения»:
 *   - `line-restart`  — линия закончилась, сессия не финиширует,
 *     бек откатывает доску к ближайшей развилке с непройденными
 *     вариантами и продолжает.
 *   - `tree-complete` — всё дерево пройдено без ошибок, сессия
 *     автоматически финишируется.
 *
 * `line-complete` оставлен для обратной совместимости и редких краевых
 * случаев; в основном flow KS-3277 фронт получает `line-restart` или
 * `tree-complete`.
 */
export type OpeningTrainerMoveResult =
  | 'correct'
  | 'wrong'
  | 'line-complete'
  | 'line-restart'
  | 'tree-complete';

// ─── Tree (ADR-077 §2.2) ──────────────────────────────────────────────

/**
 * Хард-лимиты репертуара (превышение → 400 при POST/PATCH).
 * Должны совпадать с серверной валидацией.
 */
export const OPENING_REPERTOIRE_LIMITS = {
  /** Максимум уникальных позиций (FEN'ов после транспозиций). */
  maxNodes: 2000,
  /** Максимум edges (вариантов; одна позиция может иметь несколько). */
  maxEdges: 5000,
  /** Максимум глубина в полуходах = 40 ходов. */
  maxDepthHalfMoves: 80,
  /** Максимум размер исходного PGN в байтах. */
  maxPgnBytes: 500 * 1024,
  /** Максимум репертуаров на пользователя (MVP). */
  maxRepertoiresPerUser: 50,
  /** Максимум активных (незакрытых) сессий на пользователя. */
  maxActiveSessionsPerUser: 10,
} as const;

/**
 * Скоринг (ADR-077 §2.7). Серверная функция (KS-3272) считает по этим
 * правилам, фронт повторяет логику только для предиктивного UI —
 * source of truth всегда `scoreDelta` в response.
 */
export const OPENING_TRAINER_SCORING = {
  /** Правильный ход без подсказки. */
  correctNoHint: 10,
  /** Правильный ход после `hint`. */
  correctWithHint: 5,
  /** Бонус за быстрый правильный ход (< 5 секунд от показа позиции). */
  fastBonusMs: 5000,
  fastBonusPoints: 1,
  /** Неправильный ход (минимум баланс 0 — не уходим в минус). */
  wrong: -5,
  /** Streak triggers at this count of consecutive correct moves. */
  streakThreshold: 5,
  /** Multiplier для streak-бонуса, применяется до первой ошибки. */
  streakMultiplier: 1.2,
} as const;

/**
 * Сколько подряд правильных проходов линии нужно чтобы она считалась
 * «mastered» и попала в SRS-очередь (M2). M1 хранит counter, но
 * SRS-инициализация — в M2.
 */
export const OPENING_LINE_MASTERY_THRESHOLD = 3;

/**
 * Edge — переход из родительской позиции в дочернюю по одному ходу.
 * NAG'и и комментарии сохраняются на edge'ах, потому что одна и та же
 * позиция может быть достигнута разными ходами (но это редкость).
 */
export interface RepertoireEdge {
  /** UCI хода: 'e2e4', 'e7e8q' (promotion). */
  moveUci: string;
  /** SAN хода для отображения: 'e4', 'Nf3', 'O-O'. */
  moveSan: string;
  /** FEN позиции ПОСЛЕ этого хода (ключ соответствующего child-node). */
  childFen: string;
  /**
   * Numeric Annotation Glyphs из PGN-источника (опц.).
   * `[1] = "!"`, `[2] = "?"`, `[3] = "!!"`, `[4] = "??"`, `[5] = "!?"`,
   * `[6] = "?!"`. Multi-NAG возможен (`[1,14]` = "! ±").
   */
  nag?: number[];
  /** Авторский комментарий из PGN (`{ ... }`). */
  comment?: string;
}

/**
 * Node = уникальная позиция (по FEN). Edges — все ходы из этой позиции,
 * закодированные в репертуаре. У одной позиции может быть несколько
 * edges, если автор записал несколько вариантов.
 */
export interface RepertoireNode {
  /** FEN — дубликат ключа в `RepertoireTree.nodes`, удобство для итерации. */
  fen: string;
  /** Ходы из этой позиции. Пустой массив = «конец линии» (line-complete). */
  edges: RepertoireEdge[];
}

/**
 * Дерево репертуара — структурированный PGN с транспозициями
 * (одинаковая позиция, достигнутая разными путями, схлопывается в один
 * node). Парсится на бэке при создании/обновлении репертуара.
 */
export interface RepertoireTree {
  /** FEN корневой позиции (обычно стандартная стартовая). */
  rootFen: string;
  /** Все узлы дерева, ключ — FEN позиции. */
  nodes: Record<string, RepertoireNode>;
  /** Метаданные для лимитов и UI (счётчики). */
  meta: {
    nodeCount: number;
    edgeCount: number;
    /** Максимум полуходов от корня до листа. */
    maxDepth: number;
  };
}

// ─── Domain DTOs ──────────────────────────────────────────────────────

/**
 * Карточка репертуара в списке. БЕЗ дерева — оно тяжёлое; для tree
 * запрашивается `GET /opening-trainer/repertoires/:id`.
 */
export interface OpeningRepertoireDto {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  /** Из `tree.meta`, дубликат для лобби-списка. */
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Агрегаты прогресса для tree-view покраски и лобби-стат-блока (M2,
 * в M1 заполняются нулями).
 */
export interface OpeningRepertoireStats {
  /** Линий со статусом mastered (`OPENING_LINE_MASTERY_THRESHOLD`+ подряд). */
  masteredLines: number;
  /** Линий хотя бы раз пройденных, но не masered. */
  learningLines: number;
  /** Линий с хотя бы одной ошибкой. */
  wrongLines: number;
  /** Всего уникальных листовых линий в дереве. */
  totalLines: number;
}

/** Карточка + агрегаты (опц. через `?include=stats`). */
export interface OpeningRepertoireWithStatsDto extends OpeningRepertoireDto {
  stats: OpeningRepertoireStats;
}

/** Полный вид: карточка + сохранённый PGN + дерево. */
export interface OpeningRepertoireDetailDto extends OpeningRepertoireDto {
  /** Исходный PGN (как пользователь загрузил). Для редактирования/экспорта. */
  pgn: string;
  tree: RepertoireTree;
}

/**
 * Сессия тренировки. Per-session состояние — `playedLines` (`Json` в БД),
 * не возвращается во фронт; для UX фронту достаточно `currentFen` +
 * counters.
 */
export interface OpeningTrainerSessionDto {
  id: string;
  repertoireId: string;
  side: TrainerColor;
  mode: OpeningTrainerMode;
  repeatMode: OpeningTrainerRepeatMode;
  status: OpeningTrainerSessionStatus;
  /** Текущая FEN позиция. Для resume через 7 дней. */
  currentFen: string;
  /** UCI-путь от корня до `currentFen` — для рисования стрелок последнего хода. */
  currentPath: string[];
  score: number;
  movesPlayed: number;
  correctMoves: number;
  wrongMoves: number;
  hintsUsed: number;
  startedAt: string;
  lastActivityAt: string;
  finishedAt: string | null;
}

/**
 * Одна попытка — для аудита и tree-view ошибок (M2). В M1 сохраняется,
 * наружу через API экспортируется только в `finish`-summary.
 */
export interface OpeningTrainerAttemptDto {
  id: string;
  sessionId: string;
  positionFen: string;
  /** Что ожидалось в этой позиции (массив UCI). */
  expectedMoves: string[];
  /** Что прислал пользователь (UCI). */
  userMove: string;
  correct: boolean;
  hintUsed: boolean;
  scoreDelta: number;
  /** Время от показа позиции до отправки хода (для streak/fast-bonus). */
  responseTimeMs: number;
  createdAt: string;
}

/**
 * KS-3286 (M2). Статус линии для tree-view покраски и лобби-счётчиков.
 *
 *   - `not-played` — нет записи в OpeningLineProgress (computed на фронте
 *     сопоставлением tree.nodes с массивом lines). Серый цвет.
 *   - `learning`   — есть попытки, но не mastered. Жёлтый.
 *   - `wrong`      — `wrongCount > correctCount` (преобладают ошибки). Красный.
 *   - `mastered`   — `masteredAt != null && (!sm2DueAt || sm2DueAt > now)`.
 *     Зелёный.
 *   - `due`        — mastered + `sm2DueAt <= now` (пора повторить). Синий.
 *
 * Backend вычисляет в `GET /opening-trainer/repertoires/:id/progress`
 * (KS-3292 / B6).
 */
export type OpeningLineStatus =
  | 'not-played'
  | 'learning'
  | 'wrong'
  | 'mastered'
  | 'due';

/**
 * Прогресс по конкретной линии (от root до точки замера). Per-path, не
 * per-edge — мастеринг оценивается по полной цепочке. M2.
 *
 * KS-3286: добавлено `status` (derived backend'ом) и `orphaned` —
 * флаг что линия из старого PGN больше не существует в репертуаре
 * после редактирования (M2 §2.5). Orphan не учитывается в SRS-выборках
 * и не рендерится в tree-view (KS-3294 / B8 orphan-pruning).
 */
export interface OpeningLineProgressDto {
  id: string;
  repertoireId: string;
  /** SHA-1 от `join('|', pathUci)` — короткий ключ для уникальности. */
  pathHash: string;
  pathUci: string[];
  /** Длина пути в полуходах. */
  pathLength: number;
  correctCount: number;
  wrongCount: number;
  consecutiveCorrect: number;
  lastPlayedAt: string;
  masteredAt: string | null;
  /** SM-2 SRS-поля (M2, до мастеринга — null). */
  sm2DueAt: string | null;
  sm2Interval: number | null;
  sm2Easiness: number | null;
  sm2Reps: number | null;
  /**
   * KS-3286 (M2 §2.5). `true` если линия из старого PGN больше не
   * существует в дереве (после `PATCH /repertoires/:id` с новым PGN).
   * Backend проставляет в KS-3294 (B8) при пересборке tree. Orphan'ы
   * не учитываются в SRS-выборках и не рендерятся в tree-view.
   * Default `false` — поле опц. для backward-compat (старые записи
   * без поля считаются не-orphan).
   */
  orphaned?: boolean;
  /**
   * KS-3286. Derived статус для UI — вычисляется backend'ом в
   * `GET /repertoires/:id/progress` (KS-3292). Опц. потому что
   * raw-row из БД не имеет этого поля; присутствует только в DTO.
   */
  status?: OpeningLineStatus;
}

// ─── Request bodies ───────────────────────────────────────────────────

/** `POST /opening-trainer/repertoires`. */
export interface CreateOpeningRepertoireRequest {
  title: string;
  description?: string;
  /** Исходный PGN. Лимит `OPENING_REPERTOIRE_LIMITS.maxPgnBytes`. */
  pgn: string;
}

/** `PATCH /opening-trainer/repertoires/:id`. Все поля опциональны. */
export interface UpdateOpeningRepertoireRequest {
  title?: string;
  /** `null` чтобы очистить. */
  description?: string | null;
  /** Если задан — пересборка дерева; прогресс НЕ сбрасывается. */
  pgn?: string;
}

/**
 * KS-3286 (M2 §5 / KS-3293 B7). `POST /opening-trainer/repertoires/
 * from-analysis` — конверсия из мастерской («использовать как
 * репертуар» в карточке анализа).
 *
 * Backend берёт `Analysis.pgn` из текущего юзера (owner-check), парсит
 * через тот же repertoire-builder. `title` по умолчанию = `Analysis.title`
 * или его `headline`. Чужой analysisId → 404, пустой PGN → 400.
 */
export interface CreateOpeningRepertoireFromAnalysisRequest {
  analysisId: string;
  title?: string;
  description?: string;
}

/** `POST /opening-trainer/repertoires/:id/sessions`. */
export interface StartOpeningTrainerSessionRequest {
  side: TrainerColor;
  mode: OpeningTrainerMode;
  /** Default `complete`. */
  repeatMode?: OpeningTrainerRepeatMode;
}

/** `POST /opening-trainer/sessions/:sid/move`. */
export interface OpeningTrainerMoveRequest {
  /** UCI хода: 'e2e4', 'g1f3', 'e7e8q'. */
  moveUci: string;
  /** Миллисекунды от показа позиции до отправки. Для fast-bonus / SRS. */
  responseTimeMs: number;
}

/** `POST /opening-trainer/sessions/:sid/undo`. Тело пустое. */
export type OpeningTrainerUndoRequest = Record<string, never>;

/** `POST /opening-trainer/sessions/:sid/hint`. Тело пустое. */
export type OpeningTrainerHintRequest = Record<string, never>;

/** `POST /opening-trainer/sessions/:sid/giveup`. Тело пустое. */
export type OpeningTrainerGiveupRequest = Record<string, never>;

/** `POST /opening-trainer/sessions/:sid/finish`. Тело пустое. */
export type OpeningTrainerFinishRequest = Record<string, never>;

// ─── Response bodies ──────────────────────────────────────────────────

/**
 * `GET /opening-trainer/repertoires`.
 * Поле `stats` присутствует только при `?include=stats`.
 */
export interface ListOpeningRepertoiresResponse {
  repertoires: Array<OpeningRepertoireDto | OpeningRepertoireWithStatsDto>;
}

/** `POST /opening-trainer/repertoires` — возвращает полный repertoire с tree. */
export type CreateOpeningRepertoireResponse = OpeningRepertoireDetailDto;

/** `GET /opening-trainer/repertoires/:id` — карточка + дерево. */
export type GetOpeningRepertoireResponse = OpeningRepertoireDetailDto;

/** `PATCH /opening-trainer/repertoires/:id` — обновлённая карточка + дерево. */
export type UpdateOpeningRepertoireResponse = OpeningRepertoireDetailDto;

/** `DELETE /opening-trainer/repertoires/:id` — soft-delete confirmation. */
export interface DeleteOpeningRepertoireResponse {
  id: string;
  deletedAt: string;
}

/**
 * `POST /opening-trainer/repertoires/:id/sessions`.
 *
 * Если играем чёрными — первый бот-ход уже сделан, `initialBotMove`
 * заполнен; если белыми — `initialBotMove = null` и ожидаем ход
 * пользователя.
 */
export interface StartOpeningTrainerSessionResponse {
  session: OpeningTrainerSessionDto;
  /** Первый ход бота (когда играем чёрными). */
  initialBotMove: { moveUci: string; moveSan: string; newFen: string } | null;
}

/** `GET /opening-trainer/sessions/:sid`. */
export interface GetOpeningTrainerSessionResponse {
  session: OpeningTrainerSessionDto;
}

// ─── Discriminated union для /move response (ADR-077 §2.4) ────────────
//
// Сужение по дискриминатору `result` гарантирует, что фронт получает
// нужные поля для каждого исхода. Тест на narrowing — в .test.ts рядом.

interface OpeningTrainerMoveBaseResponse {
  result: OpeningTrainerMoveResult;
  session: OpeningTrainerSessionDto;
}

/** Правильный ход: применён, бот-ход (если ещё не end-of-line). */
export interface OpeningTrainerMoveCorrectResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'correct';
  applied: true;
  scoreDelta: number;
  newFen: string;
  /** Бот ответил. `null` если после нашего хода — конец линии. */
  botMove: {
    moveUci: string;
    moveSan: string;
    newFen: string;
  } | null;
}

/** Неправильный ход: не применён, есть подсказка по правильным вариантам. */
export interface OpeningTrainerMoveWrongResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'wrong';
  applied: false;
  /** `-5` обычно (см. OPENING_TRAINER_SCORING.wrong). */
  scoreDelta: number;
  /** Что было правильно — для popup'а «попробовать снова». */
  expectedMoves: Array<{ moveUci: string; moveSan: string }>;
}

/**
 * Линия закончилась — нет edges из новой позиции (`newFen`). Фронт
 * показывает «линия пройдена», предлагает выбор: вернуться на развилку
 * выше / начать с начала / закончить сессию.
 */
export interface OpeningTrainerMoveLineCompleteResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'line-complete';
  applied: true;
  scoreDelta: number;
  newFen: string;
}

/**
 * KS-3277. Линия закончилась (или бот не нашёл непройденный вариант
 * в текущей позиции), бекенд автоматически откатил доску к ближайшей
 * развилке с непройденными edges. Сессия НЕ финиширует — пользователь
 * продолжает играть из нового стартового FEN'а.
 */
export interface OpeningTrainerMoveLineRestartResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'line-restart';
  applied: true;
  scoreDelta: number;
  /** FEN, в который перенесли доску (новая branch-стартовая позиция). */
  newFen: string;
  /** UCI-путь от root до `newFen` — фронт ре-рендерит доску по этому пути. */
  newPath: string[];
  /**
   * Опц. бот-ход из новой позиции (если сейчас очередь бота). Когда
   * `null` — ожидаем ход пользователя из `newFen`.
   */
  botMove: {
    moveUci: string;
    moveSan: string;
    newFen: string;
  } | null;
}

/**
 * KS-3277. Всё дерево репертуара пройдено без ошибок — финал-экран
 * «дерево выучено». Сессия автоматически финиширована (`status='finished'`).
 */
export interface OpeningTrainerMoveTreeCompleteResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'tree-complete';
  applied: true;
  scoreDelta: number;
  /** Финальная FEN — позиция, в которой завершилось дерево. */
  newFen: string;
}

export type OpeningTrainerMoveResponse =
  | OpeningTrainerMoveCorrectResponse
  | OpeningTrainerMoveWrongResponse
  | OpeningTrainerMoveLineCompleteResponse
  | OpeningTrainerMoveLineRestartResponse
  | OpeningTrainerMoveTreeCompleteResponse;

/** `POST /opening-trainer/sessions/:sid/hint`. */
export interface OpeningTrainerHintResponse {
  /** Один правильный ход (если их несколько — рандомный). */
  hint: { moveUci: string; moveSan: string };
  session: OpeningTrainerSessionDto;
}

/**
 * `POST /opening-trainer/sessions/:sid/giveup`.
 * Возвращает все правильные + переходит на бот-ход (если after-our-move
 * не end-of-line). Помечает попытку как wrong.
 */
export interface OpeningTrainerGiveupResponse {
  expectedMoves: Array<{ moveUci: string; moveSan: string }>;
  botMove: {
    moveUci: string;
    moveSan: string;
    newFen: string;
  } | null;
  newFen: string;
  session: OpeningTrainerSessionDto;
}

/**
 * `POST /opening-trainer/sessions/:sid/undo`.
 * Откатывает последний полуход (наш или бот'а — фронт сам решит, что
 * показать). Возвращается отрицательный `scoreDelta` (компенсация).
 */
export interface OpeningTrainerUndoResponse {
  newFen: string;
  /** Отрицательное значение (компенсация прошлого +N). */
  scoreDelta: number;
  session: OpeningTrainerSessionDto;
}

/**
 * `POST /opening-trainer/sessions/:sid/finish`.
 * Закрывает сессию, агрегирует попытки в `OpeningLineProgress`
 * (M2 — в M1 progress не пишется, summary считается прямо из attempts).
 */
export interface OpeningTrainerFinishResponse {
  session: OpeningTrainerSessionDto;
  summary: {
    score: number;
    movesPlayed: number;
    correctMoves: number;
    wrongMoves: number;
    hintsUsed: number;
    /** Количество линий, дошедших до line-complete за сессию. */
    linesCompleted: number;
  };
}

/** `GET /opening-trainer/repertoires/:id/progress` (M2). */
export interface GetOpeningRepertoireProgressResponse {
  repertoireId: string;
  lines: OpeningLineProgressDto[];
}

/**
 * KS-3286 (M2 §5 / KS-3294 B8). `GET /opening-trainer/repertoires/:id/
 * active-session` — последняя неоконченная сессия пользователя по этому
 * репертуару с `finishedAt IS NULL AND lastActivityAt > now - 7d`,
 * иначе `null`. Используется для sticky-карточки «продолжить
 * тренировку» на странице репертуара.
 */
export interface GetOpeningRepertoireActiveSessionResponse {
  session: OpeningTrainerSessionDto | null;
}

/** `GET /opening-trainer/reviews/due` (M2 — SRS-очередь). */
export interface GetOpeningReviewsDueResponse {
  lines: Array<
    OpeningLineProgressDto & {
      /** Денормализация — фронту не нужно ходить отдельно за repertoire. */
      repertoireTitle: string;
    }
  >;
}

// ─── Type guards для discriminated union ──────────────────────────────

export function isCorrectMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveCorrectResponse {
  return r.result === 'correct';
}

export function isWrongMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveWrongResponse {
  return r.result === 'wrong';
}

export function isLineCompleteMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveLineCompleteResponse {
  return r.result === 'line-complete';
}

/** KS-3277. Type guard для `line-restart`. */
export function isLineRestartMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveLineRestartResponse {
  return r.result === 'line-restart';
}

/** KS-3277. Type guard для `tree-complete`. */
export function isTreeCompleteMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveTreeCompleteResponse {
  return r.result === 'tree-complete';
}
