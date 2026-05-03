/**
 * KS-2224 (ADR-035 §2.1, §4 / methodology §2-3).
 *
 * Контракты drill-системы: типы drill, answer-shape, attempt и sprint score.
 * Единый источник истины для:
 *   - apps/api/tactic-drill (controller'ы, validator)
 *   - apps/web (drill page, palette, lobby)
 *   - индексер apps/api/scripts/index-tactic-drills.ts
 *
 * KS-2226: скопировано из docs/architecture/tactical-drill-api-contract.md §2
 * (см. там же §10 чек-лист). Источник истины — этот документ; при
 * расхождении синхронизировать с ним, не наоборот.
 */

// ─── Каталог drill-типов ─────────────────────────────────────────────────

/**
 * 8 drill-типов из methodology §2. Расширение в v2 — отдельным PR с
 * обновлением methodology и этого union'а.
 */
export type TacticDrillType =
  | 'find-hanging-piece'
  | 'find-loose-piece'
  | 'find-pin'
  | 'find-fork'
  | 'find-mate-in-one-square'
  | 'count-attackers'
  | 'find-all-checks'
  | 'find-undefended-attack';

/**
 * Группировка drill-типов по навыковому слою (methodology §2.1).
 * Используется в lobby для секционирования и в analytics.
 */
export type TacticDrillSkillLayer = 'overview' | 'pattern' | 'calculation';

export const DRILL_TYPE_LAYER: Record<TacticDrillType, TacticDrillSkillLayer> = {
  'count-attackers':         'overview',
  'find-loose-piece':        'overview',
  'find-hanging-piece':      'overview',
  'find-all-checks':         'pattern',
  'find-pin':                'pattern',
  'find-fork':               'pattern',
  'find-mate-in-one-square': 'calculation',
  'find-undefended-attack':  'calculation',
};

/**
 * Порядок прохождения для строгого режима lobby (methodology §4).
 * После прохождения всех 8 — порядок снимается, открыт свободный выбор.
 */
export const DRILL_TYPE_ORDER: TacticDrillType[] = [
  'count-attackers',
  'find-loose-piece',
  'find-hanging-piece',
  'find-all-checks',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
  'find-undefended-attack',
];

// ─── Answer-shape ────────────────────────────────────────────────────────

/**
 * 4 формата ответа. Discriminator — поле `shape` в каждом варианте.
 * Связь shape ↔ drill-type фиксирована в DRILL_TYPE_ANSWER_SHAPE ниже.
 */
export type AnswerShape = 'square' | 'squares' | 'number' | 'move';

/**
 * Связь drill-type → ожидаемый answer-shape (methodology §2,
 * ADR-035 §2.1 финальный после KS-2223 §8.3 правок).
 *
 * Для `find-mate-in-one-square` — строго `'square'` (fallback на `'move'`
 * отменён в KS-2223).
 */
export const DRILL_TYPE_ANSWER_SHAPE: Record<TacticDrillType, AnswerShape> = {
  'find-hanging-piece':      'square',
  'find-loose-piece':        'square',
  'find-pin':                'square',
  'find-fork':               'square',
  'find-mate-in-one-square': 'square',
  'count-attackers':         'number',
  'find-all-checks':         'squares',
  'find-undefended-attack':  'move',
};

/**
 * Шахматная клетка в нотации `<file><rank>`, file ∈ a..h, rank ∈ 1..8.
 * Совпадает с chess.js типом, но в shared не зависим от chess.js (он —
 * клиентская валидация). Backend проверяет regex /^[a-h][1-8]$/.
 */
export type Square = string;

/** Дискриминированное объединение для поля `answer` (эталон) и `userAnswer`. */
export type AnswerData =
  | AnswerSquare
  | AnswerSquares
  | AnswerNumber
  | AnswerMove;

/** shape='square' — одна правильная клетка. */
export interface AnswerSquare {
  shape: 'square';
  /** Например `'e4'`. */
  square: Square;
}

/**
 * shape='squares' — множество клеток-ответов (для `find-all-checks`).
 * Порядок в массиве не важен — валидатор сравнивает как множество.
 * Дубли в `squares` — невалидный ответ (валидатор отклонит).
 */
export interface AnswerSquares {
  shape: 'squares';
  /** Например `['e4', 'f6', 'g7']`. */
  squares: Square[];
}

/** shape='number' — целое 1–4 для `count-attackers`. */
export interface AnswerNumber {
  shape: 'number';
  /** Целое 1..4. Backend валидирует диапазон. */
  value: number;
}

/** shape='move' — пара from→to для `find-undefended-attack`. */
export interface AnswerMove {
  shape: 'move';
  from: Square;
  to: Square;
  /**
   * Опционально — promotion piece (`'q'|'r'|'b'|'n'`). Для drill v1 не
   * используется (промоушены отбраковываются генератором), оставлено
   * на v2.
   */
  promotion?: 'q' | 'r' | 'b' | 'n';
}

// ─── DTO drill (для GET /next, /sprint/start) ────────────────────────────

/**
 * Drill-задача, отдаваемая клиенту. **Ключевое:** поле `answer` НИКОГДА
 * не присутствует — иначе клиент читает devtools и обходит проверку.
 * Эталон хранится только на backend в `tactic_drills.answer` JSONB.
 */
export interface TacticDrillDto {
  /** UUID. */
  id: string;
  drillType: TacticDrillType;
  /** FEN исходной позиции (без предварительного хода — в отличие от Puzzle). */
  fen: string;
  /**
   * Чья сторона на ходу. Для drill'ов где `side-to-move` неважна
   * (`find-pin`, `find-loose-piece`, `count-attackers`) — `null`,
   * frontend не показывает индикатор хода.
   */
  sideToMove: 'w' | 'b' | null;
  /** Ожидаемый формат ответа (для UI: один клик / много / число / from→to). */
  answerShape: AnswerShape;
  /** Сложность 1..5 (см. KS-2225 формула). */
  difficulty: number;
  /**
   * Метаданные для UI:
   *   - highlightedSquare: для `count-attackers` показать выделенную клетку
   *   - expectedCount: для `squares` — сколько правильных клеток ожидается
   *     (frontend показывает прогресс «3/5 выбрано»). Для всех остальных —
   *     undefined.
   */
  meta?: {
    highlightedSquare?: Square;
    expectedCount?: number;
  };
}

// ─── DTO эталона (только server-side, в БД) ──────────────────────────────

/**
 * Эталон, хранится в `tactic_drills.answer` (JSONB). НЕ выходит за пределы
 * backend'а. Включается в response **только** в `/api/tactic-drill/attempt`
 * после submit'а — для feedback (показать правильный ответ).
 *
 * См. §3 — JSON-shape для каждого варианта.
 */
export type TacticDrillAnswer = AnswerData;

// ─── Attempt (POST /attempt и /sprint/submit) ────────────────────────────

export interface TacticDrillAttemptRequest {
  /** UUID drill'а. */
  drillId: string;
  /** Что кликнул пользователь. */
  userAnswer: AnswerData;
  /** Сколько мс ушло от показа задачи до submit'а. */
  timeMs: number;
  /**
   * Режим: `'drill'` (одиночный) | `'sprint'` (микс) | `'lessons-embed'`
   * (drill в составе урока — KS-DRILL-LESSON-STEP, v2.x).
   */
  mode: 'drill' | 'sprint' | 'lessons-embed';
  /** Только для `mode='sprint'` — UUID активной sprint-сессии. */
  sessionId?: string;
}

/**
 * Ответ на submit. `solved` определяется по правилам §4 валидатора.
 * `correctAnswer` отдаётся для feedback-overlay (зелёная подсветка
 * правильных клеток + красная — выбранных пользователем неверных).
 */
export interface TacticDrillAttemptResponse {
  attemptId: string;
  solved: boolean;
  /** Эталон. Подсвечивается на доске после submit. */
  correctAnswer: AnswerData;
  /**
   * Метрики (для shape='squares' — TP/FP/FN; для остальных undefined).
   * См. §4.
   */
  metrics?: {
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    /** IoU = TP / (TP + FP + FN). Округление до 2 знаков. */
    iou: number;
  };
}

// ─── Sprint session (mixed-types режим) ──────────────────────────────────

export interface TacticDrillSprintStartRequest {
  /**
   * Длительность сессии в мс. Допустимо `180000` (3 мин) или `300000`
   * (5 мин). Backend валидирует whitelist.
   */
  durationMs: 180000 | 300000;
  /**
   * Подмножество drill-типов для sprint'а. Пустой массив = все 8.
   * Используется для режима «sprint только по checks» и т.п.
   */
  types: TacticDrillType[];
}

export interface TacticDrillSprintStartResponse {
  sessionId: string;
  /** Первая задача sprint'а — без `answer`. */
  drill: TacticDrillDto;
  startedAt: string; // ISO
  durationMs: number;
}

export interface TacticDrillSprintSubmitResponse {
  /** Результат текущей задачи (как в `/attempt`). */
  attempt: TacticDrillAttemptResponse;
  /**
   * Следующая задача или `null` если сессия закончилась (по времени или
   * после submit'а). При `null` смотри `final` ниже.
   */
  next: TacticDrillDto | null;
  /** Заполнено только когда `next === null`. */
  final?: {
    scoreId: string;
    score: number;       // правильных задач
    accuracy: number;    // [0..1]
    avgPrecision: number; // среднее IoU по shape='squares' задачам [0..1]
  };
}

/** Запись лидерборда. */
export interface TacticDrillSprintScoreItem {
  userId: string;
  username: string;
  /** Например `'3min-mixed'` или `'5min-checks-only'`. */
  mode: string;
  score: number;
  accuracy: number;
  createdAt: string; // ISO
}

// ─── Stats ───────────────────────────────────────────────────────────────

/** Per-drill-type breakdown статистики юзера (GET /stats/me). */
export interface TacticDrillStatsItem {
  drillType: TacticDrillType;
  attempts: number;
  solved: number;
  /** [0..1]. */
  accuracy: number;
  /** Среднее timeMs по успешным попыткам. */
  avgTimeMs: number;
  /** Среднее IoU для shape='squares' (только если drillType='find-all-checks'). */
  avgIou?: number;
}

export interface TacticDrillStatsResponse {
  total: {
    attempts: number;
    solved: number;
    accuracy: number;
  };
  byType: TacticDrillStatsItem[];
  /** Какие drill-типы юзер прошёл хотя бы раз (для unlock-логики lobby). */
  unlocked: TacticDrillType[];
}
