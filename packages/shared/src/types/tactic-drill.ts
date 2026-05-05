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
 * 7 drill-типов из methodology §2. Расширение в v2 — отдельным PR с
 * обновлением methodology и этого union'а.
 *
 * KS-2393: тип `mate-in-1 (deprecated)` удалён (см. KS-2392 ADR).
 * Strict-uniqueness predicate'а на TWIC-корпусе давал ~6 позиций (>99%
 * отсев). Решено убрать раздел целиком вместо расширения корпуса.
 */
export type TacticDrillType =
  | 'find-hanging-piece'
  | 'find-loose-piece'
  | 'find-pin'
  | 'find-fork'
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
  'find-undefended-attack':  'calculation',
};

/**
 * Порядок прохождения для строгого режима lobby (methodology §4).
 * После прохождения всех 7 — порядок снимается, открыт свободный выбор.
 *
 * KS-2393: исключён `mate-in-1 (deprecated)`.
 */
export const DRILL_TYPE_ORDER: TacticDrillType[] = [
  'count-attackers',
  'find-loose-piece',
  'find-hanging-piece',
  'find-all-checks',
  'find-pin',
  'find-fork',
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
 * KS-2393: запись `mate-in-1 (deprecated)` удалена вместе с типом.
 */
export const DRILL_TYPE_ANSWER_SHAPE: Record<TacticDrillType, AnswerShape> = {
  // KS-2335 (после KS-2337 backend): find-hanging-piece переведён с
  // 'square' на 'move' — drill теперь требует «возьми незащищённую
  // фигуру одним ходом», ответ {from, to}. Strict-uniqueness по паре
  // (from, to). См. docs/architecture/KS-2335-find-hanging-piece-move-shape.md.
  'find-hanging-piece':      'move',
  'find-loose-piece':        'square',
  'find-pin':                'square',
  // KS-2400: find-fork переведён с 'square' (укажи фигуру-вилку,
  // которая уже стоит) на 'move' (сделай ход, создающий новую
  // вилку). Snapshot before/after, см. predicate find-fork.ts.
  'find-fork':               'move',
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
   * (`find-pin`, `count-attackers`) — `null`, frontend не показывает
   * индикатор хода.
   *
   * KS-2415: `find-loose-piece` теперь side-sensitive — backend
   * выводит `sideToMove` из FEN, в DTO `'w' | 'b'`, не `null`.
   */
  sideToMove: 'w' | 'b' | null;
  /** Ожидаемый формат ответа (для UI: один клик / много / число / from→to). */
  answerShape: AnswerShape;
  /** Сложность 1..5 (см. KS-2225 формула). */
  difficulty: number;
  /**
   * Метаданные для UI:
   *   - highlightedSquare: для `count-attackers` показать выделенную клетку
   *   - attackerColor: для `count-attackers` цвет атакующих ('w'|'b').
   *     Frontend отображает в вопросе и индикаторе (KS-2367/KS-2369).
   *   - expectedCount: для `squares` — сколько правильных клеток ожидается
   *     (frontend показывает прогресс «3/5 выбрано»). Для всех остальных —
   *     undefined.
   *   - expectedMoves: KS-2397, для `find-all-checks` — полный список
   *     check-ходов как пары `{from, to}`. answerShape остаётся 'squares'
   *     (валидатор отвечает по `to`-клеткам), но фронту нужен полный
   *     список ходов для рендера/подсветки/наведения. Заполняется
   *     индексером при импорте; для существующих записей — через
   *     одноразовый backfill (`scripts/backfill-find-all-checks-meta.ts`).
   */
  meta?: {
    highlightedSquare?: Square;
    attackerColor?: 'w' | 'b';
    expectedCount?: number;
    expectedMoves?: { from: Square; to: Square }[];
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

// ─── KS-2250: Daily drill (Telegram-рассылка) ────────────────────────

/** Локализованная строка `{ru, en}`. */
export interface DrillLocalizedString {
  ru: string;
  en: string;
}

/**
 * KS-2250 (ADR-035 §11 / E6). Локализованное короткое название
 * drill-типа — для overlay картинки и `drillTypeLabel` в response
 * `/api/tactic-drill/daily`. Если нужно добавить новый тип — добавлять
 * сюда + в `DRILL_INSTRUCTION` + `DRILL_HINT`.
 */
export const DRILL_TYPE_LABEL: Record<TacticDrillType, DrillLocalizedString> = {
  'find-hanging-piece':      { ru: 'Зависшая фигура',     en: 'Hanging piece' },
  'find-loose-piece':        { ru: 'Слабо защищённая',     en: 'Loose piece' },
  'find-pin':                { ru: 'Связка',                en: 'Pin' },
  'find-fork':               { ru: 'Вилка',                 en: 'Fork' },
  'count-attackers':         { ru: 'Сосчитать атакующих',  en: 'Count attackers' },
  'find-all-checks':         { ru: 'Все шахи',              en: 'All checks' },
  'find-undefended-attack':  { ru: 'Безответная атака',    en: 'Undefended attack' },
};

/**
 * Развёрнутая инструкция per-type (≤ 100 символов на язык).
 * Используется как `drill.instruction` в response, и в подписи Telegram.
 * Per-drill индивидуальные инструкции — отдельная задача (требует
 * миграции БД и контента). MVP — общее по типу.
 */
export const DRILL_INSTRUCTION: Record<TacticDrillType, DrillLocalizedString> = {
  'find-hanging-piece':      {
    // KS-2335: drill теперь требует ход-взятие, а не клик клетки.
    ru: 'Возьми ходом фигуру противника без защитников.',
    en: 'Capture an undefended enemy piece in one move.',
  },
  'find-loose-piece':        {
    ru: 'Найди фигуру противника, у которой нет ни одного защитника.',
    en: "Find an opponent's piece without any defenders.",
  },
  'find-pin':                {
    ru: 'Найди связанную фигуру — ту, которая не может уйти из-за более ценной за ней.',
    en: "Find the pinned piece — it can't move because of a more valuable piece behind it.",
  },
  'find-fork':               {
    // KS-2400: формулировка под shape='move' (создай новую вилку).
    ru: 'Сделай ход, после которого твоя фигура одновременно атакует ≥2 ценных фигур противника.',
    en: 'Make a move that creates a fork — your piece attacking ≥2 valuable enemy pieces.',
  },
  'count-attackers':         {
    ru: 'Сколько фигур заданного цвета атакуют выделенную клетку?',
    en: 'How many pieces of the specified color attack the highlighted square?',
  },
  'find-all-checks':         {
    ru: 'Отметь ВСЕ клетки «to», ход на которые даёт шах.',
    en: 'Mark ALL destination squares where a move gives check.',
  },
  'find-undefended-attack':  {
    ru: 'Найди ход, после которого ты атакуешь беззащитную фигуру противника.',
    en: 'Find the move that creates an attack on an undefended enemy piece.',
  },
};

/**
 * Короткая подсказка `hint{ru,en}` ≤ 90 символов (требование marketing
 * для Telegram caption). Per-type, не per-drill (как и instruction).
 */
export const DRILL_HINT: Record<TacticDrillType, DrillLocalizedString> = {
  'find-hanging-piece':      {
    // KS-2335: подсказка дополнена призывом «возьми её».
    ru: 'Зависшая = под боем И без защитников. Возьми её.',
    en: 'Hanging = attacked AND undefended. Take it.',
  },
  'find-loose-piece':        {
    ru: 'Слабая = без защитников. Под боем не обязательно.',
    en: 'Loose = no defenders. Attack not required.',
  },
  'find-pin':                {
    ru: 'За связанной фигурой стоит более ценная по той же линии.',
    en: 'Behind the pinned piece sits a more valuable one on the same line.',
  },
  'find-fork':               {
    // KS-2400: подсказка обновлена — drill теперь требует ход.
    ru: 'Один ход — твоя фигура атакует две цели, которые до этого были вне удара.',
    en: 'One move — your piece attacks two targets that were not under attack before.',
  },
  'count-attackers':         {
    ru: 'Учти все «батареи» по линии.',
    en: 'Count all batteries along the line.',
  },
  'find-all-checks':         {
    ru: 'Не пропусти открытый шах.',
    en: "Don't miss discovered checks.",
  },
  'find-undefended-attack':  {
    ru: 'Цель — фигура без защитников.',
    en: 'Target — a piece with no defenders.',
  },
};

/** Локализованные label'ы для difficulty (KS-2315 buckets). */
export const DRILL_DIFFICULTY_LABEL: Record<
  'easy' | 'medium' | 'hard',
  DrillLocalizedString
> = {
  easy:   { ru: 'Лёгкая',  en: 'Easy' },
  medium: { ru: 'Средняя', en: 'Medium' },
  hard:   { ru: 'Сложная', en: 'Hard' },
};

/**
 * Расписание сложности по дню недели (см. /tmp/KS-2250/schedule.md и
 * api-contract.md). 0 = Воскресенье в JS-нотации `Date.getUTCDay()`.
 *  - Пн (1), Вт (2), Чт (4) → easy
 *  - Ср (3), Пт (5)         → medium
 *  - Сб (6), Вс (0)         → hard
 */
export const DAILY_DRILL_DIFFICULTY_BY_WEEKDAY: Record<
  number,
  'easy' | 'medium' | 'hard'
> = {
  0: 'hard',   // Воскресенье
  1: 'easy',   // Понедельник
  2: 'easy',   // Вторник
  3: 'medium', // Среда
  4: 'easy',   // Четверг
  5: 'medium', // Пятница
  6: 'hard',   // Суббота
};

/**
 * KS-2250 (ADR-035 §11 / E6). Response `GET /api/tactic-drill/daily`
 * для Telegram-бота и daily-страницы сайта.
 */
export interface DailyTacticDrillResponse {
  /** Дата drill'а (UTC, ISO `YYYY-MM-DD`). */
  date: string;
  /** Сам drill — без `answer` (api-contract §7), как в `/next`/`/by-step`. */
  drill: TacticDrillDto & {
    /**
     * Контекст рендера: подсветка клеток в overlay. Derive: для
     * `count-attackers` — `[meta.highlightedSquare]`, для остальных
     * 7 типов — `[]`. Если позже понадобится подсвечивать другие
     * клетки — добавим JSON-колонку в `tactic_drills`.
     */
    context: {
      highlight: string[];
    };
    /** Локализованная инструкция per-type (см. `DRILL_INSTRUCTION`). */
    instruction: string;
  };
  drillTypeLabel: DrillLocalizedString;
  difficulty: 'easy' | 'medium' | 'hard';
  difficultyLabel: DrillLocalizedString;
  hint: DrillLocalizedString;
  /** URL без UTM-меток (бот добавляет сам). */
  siteUrl: string;
  /** URL картинки (Plan A: CDN; Plan B: статический backend-endpoint). */
  imageUrl: string;
  /** `true` если drill повторно использован из-за исчерпания банка. */
  isRepeat: boolean;
  /** Если `isRepeat=true` — дата предыдущего показа (ISO `YYYY-MM-DD`). */
  originalDate: string | null;
}

/**
 * KS-2315 (ADR-035 §11 / E6). Ответ резолвера
 * `GET /tactic-drill/by-step/:stepId` для рендера drill-step внутри
 * lesson-player'а.
 *
 * `drill` — тот же `TacticDrillDto` без `answer` (как `/next`). `stepMeta`
 * — параметры шага из `LessonStep.payload` (DrillStepPayload в shared
 * lessons.ts), нужны frontend'у для счётчика «N решено из M». `progress`
 * server-side в MVP не возвращается — frontend считает локально.
 */
export interface TacticDrillByStepResponse {
  drill: TacticDrillDto;
  stepMeta: {
    stepId: string;
    /** Сколько drill'ов нужно показать в шаге всего. `payload.count ?? 1`. */
    count: number;
    /** Минимум solved для зачёта шага. `payload.minSolved ?? count`. */
    minSolved: number;
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
