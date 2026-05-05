/**
 * Shared types for the Lessons module (MVP).
 *
 * Источники истины:
 *   - docs/architecture/lessons-module.md — архитектурный обзор
 *   - docs/architecture/lessons-roadmap.md — план декомпозиции (L-02)
 *   - docs/adr/0024-lessons-module.md — ADR (в работе, L-01); финальная
 *     сверка типов — после его утверждения
 *
 * Контракт для REST API (apps/api) и фронта (apps/web). Бэкендовые
 * class-validator DTO должны повторять поля этих типов (packages/shared —
 * единственный источник истины для shape'а).
 *
 * JSONB `payload` шагов валидируется на бэке class-validator'ом и на
 * входе seed-линтером, а тут — дискриминированным union'ом `StepPayload`
 * по полю `type`.
 */

import type { PuzzleTheme } from './puzzle.js';
import type { TacticDrillType } from './tactic-drill.js';

// ─── Common ──────────────────────────────────────────────────────────

/** Уровни курсов (соответствует `Course.level`). */
export type CourseLevel = 'beginner' | 'intermediate' | 'advanced';

/**
 * «Тип» урока (атрибут `Lesson.kind`) — подсказывает фронту, какой основной
 * контент в уроке. Реальный рендер определяют шаги (`LessonStep.type`).
 */
export type LessonKind =
  | 'theory'
  | 'tactics_set'
  | 'endgame_set'
  | 'opening_line'
  | 'game_review'
  | 'quiz';

/**
 * Типы шагов. В MVP реально отрендерены `text`, `puzzle`, `quiz`
 * (см. lessons-roadmap.md §1). Остальные (`position`, `game_review`,
 * `video`) зарезервированы — их payload'ы объявлены как «заглушки»,
 * чтобы бэк-валидация и фронт-диспетчер имели единый словарь `type`'ов.
 */
export type LessonStepType =
  | 'text'
  | 'puzzle'
  | 'quiz'
  | 'position'
  | 'game_review'
  | 'video'
  | 'endgame_drill'
  | 'opening_drill'
  /**
   * KS-2249 (ADR-035 §11 / E6): тактический drill в составе урока.
   * Использует ту же drill-инфраструктуру (predicates / rating /
   * sprint), что и автономный режим, но рендерится как шаг урока.
   */
  | 'drill';

/** Статус прохождения шага внутри урока (агрегат в `UserLessonProgress.stepsState`). */
export type LessonStepState = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

// ─── Step payloads (discriminated union by `type`) ───────────────────

/**
 * Курируемый набор задач внутри `PuzzleStep`. Три режима:
 *  - `ids` — явный список id из системной puzzle-БД (Lichess).
 *  - `filter` — фильтр `themes + rating` по той же системной БД.
 *  - `custom` — авторские задачи, заданные прямо в payload (ADR-029).
 *    Не ссылаются на `puzzles` таблицу; рейтинг не считается;
 *    `submitAttempt` не вызывается. См. `CustomPuzzle` ниже.
 */
export type PuzzleStepSelection =
  | {
      mode: 'ids';
      puzzleIds: string[];
    }
  | {
      mode: 'filter';
      themes: PuzzleTheme[];
      ratingMin?: number;
      ratingMax?: number;
      /** Сколько задач выдавать в рамках шага. */
      limit: number;
    }
  | {
      mode: 'custom';
      /**
       * Авторские задачи. 1..20 на шаг (лимит см.
       * `USER_COURSES_LIMITS.customPuzzlesPerStep` в API). Хранятся
       * прямо в payload, в системную puzzle-БД не пишутся.
       */
      customPuzzles: CustomPuzzle[];
    };

/**
 * Custom puzzle — авторская задача в шаге пользовательского курса
 * (ADR-029). Самодостаточна: всё что нужно для рендера и проверки
 * решения — внутри объекта.
 */
export interface CustomPuzzle {
  /** Стартовый FEN. Валидируется chess.js при сохранении шага. */
  fen: string;
  /**
   * Последовательность ходов решения в UCI: `['e2e4','e7e5',...]`.
   * Первый ход — ход ученика (в отличие от системного `puzzle.moves`,
   * где первый — setup). Чётность обработана в runner'е через
   * `PuzzleDto.firstMoveIsUser`. Длина 1..40 (см. лимиты ADR §2.5).
   */
  solutionMoves: string[];
  /**
   * Какой цвет внизу при рендере доски. По умолчанию — сторона,
   * которая ходит в стартовом FEN (определяется runner'ом).
   */
  orientation?: 'white' | 'black';
  /**
   * Опциональные авторские теги (UI-подсказка, не валидируются как
   * `PuzzleTheme` enum). Не идут в leaderboard/recommendations.
   * 0..5 тегов, длина каждого 1..30 символов.
   */
  themes?: string[];
  /** Опциональная авторская подпись над доской. 0..200 символов. */
  caption?: string;
}

/**
 * Статья + FEN-диаграммы (read-only). Контент — markdown.
 *
 * ## Синтаксис FEN внутри markdown
 *
 * Поддерживается два варианта встраивания диаграмм (эквивалентны, выбор
 * на усмотрение автора урока):
 *
 * ### 1. Reference-плейсхолдер `{{diagram:N}}`
 *
 * `N` — индекс в `payload.diagrams` (начиная с 0). Пример:
 *
 * ```markdown
 * Рассмотрим начальную позицию:
 *
 * {{diagram:0}}
 *
 * Белые ходят первыми…
 * ```
 *
 * `payload.diagrams[0]` содержит `{ fen, caption?, orientation? }`.
 *
 * ### 2. Inline fenced-блок ```fen [orientation]```
 *
 * `orientation` — `white` или `black`, по умолчанию `white`. FEN-строка
 * идёт первой непустой строкой блока, опциональная подпись — на отдельной
 * строке после префикса `caption:`. Пример:
 *
 * ````markdown
 * Защита Каро-Канн начинается так:
 *
 * ```fen
 * rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2
 * caption: После 1.e4 c6
 * ```
 * ````
 *
 * Inline-форма удобна для одноразовых диаграмм (не нужно описывать их в
 * `payload.diagrams`). Reference-форма удобна, если на одну диаграмму
 * ссылаются несколько раз или её описывают декларативно (полезно для
 * seed-линтера и переводов).
 *
 * Реализация — `apps/web/src/components/lessons/steps/TextStep.tsx`
 * (KS-1763 / L-08).
 */
/**
 * KS-1994: стрелка на диаграмме (как chess-arrows).
 * `from`/`to` — клетки в нотации `[a-h][1-8]`. `color` — опц. CSS-цвет
 * (`#ff0000`, `red` и т. п.); если не задан, FE использует свой
 * дефолт.
 */
export interface DiagramArrow {
  from: string;
  to: string;
  color?: string;
}

/**
 * KS-1994: подсвеченная клетка на диаграмме (точкой или заливкой).
 * `square` — клетка в нотации `[a-h][1-8]`. `color` — опц. CSS-цвет.
 */
export interface DiagramHighlight {
  square: string;
  color?: string;
}

/**
 * Read-only диаграмма внутри `TextStep`.
 *
 * KS-1994: добавлены опц. `arrows` и `highlightedSquares` — для
 * визуальных подсказок в духе диаграмм Капабланки (стрелки «как
 * ходит фигура», подсветка целевых полей). Если поля не заданы —
 * рендер прежний (только FEN).
 */
export interface TextDiagram {
  fen: string;
  caption?: string;
  /** Какой цвет снизу при рендере диаграммы. */
  orientation?: 'white' | 'black';
  /** Стрелки куда могут пойти фигуры. */
  arrows?: DiagramArrow[];
  /** Подсвеченные клетки (целевые поля и т. п.). */
  highlightedSquares?: DiagramHighlight[];
}

export interface TextStepPayload {
  type: 'text';
  /** i18n-ключ тела статьи (markdown) либо сам markdown, если `inline` */
  bodyI18nKey?: string;
  /** Альтернатива `bodyI18nKey`: прямой markdown (для простых seed'ов). */
  bodyMarkdown?: string;
  /**
   * FEN-диаграммы, встроенные в статью. Рендерятся read-only, порядок
   * совпадает с порядком плейсхолдеров вида `{{diagram:0}}` в markdown.
   */
  diagrams?: TextDiagram[];
}

/** Решение тактических задач (обёртка над `PuzzleBoard`/PuzzleModule). */
export interface PuzzleStepPayload {
  type: 'puzzle';
  selection: PuzzleStepSelection;
  /** Минимальное число решённых для зачёта шага (по умолчанию = все). */
  minSolved?: number;
}

/** Мини-тест с мульти-выбором (локальная проверка на фронте в MVP). */
export interface QuizStepPayload {
  type: 'quiz';
  questions: QuizQuestion[];
  /** Порог «зачёт» по шагу: доля правильных ответов 0..1 (по умолчанию 0.7). */
  passThreshold?: number;
}

export interface QuizQuestion {
  id: string;
  /**
   * KS-1982: текст вопроса инлайном. Контент quiz'а — это локальный
   * текст конкретного курса; локализация делается отдельным курсом
   * (другая запись в БД), не переводом. i18n-ключи здесь не нужны и
   * удалены — никакой `promptI18nKey` / `explanationI18nKey`.
   */
  prompt: string;
  /** Опционально: FEN-диаграмма под вопросом. */
  fen?: string;
  options: QuizOption[];
  /** id правильного варианта(ов). */
  correctOptionIds: string[];
  /** true — несколько правильных; false — один. */
  multi?: boolean;
  /** Опционально: разбор после ответа. Не у всех вопросов он есть. */
  explanation?: string;
}

export interface QuizOption {
  id: string;
  /** Текст варианта инлайном (KS-1982). i18n-ключ не используется. */
  label: string;
}

// ─── Step payloads: заделы под следующие итерации (пустышки) ──────────

/**
 * Интерактивная позиция (итерация 2, L-23). В MVP тип зарезервирован,
 * payload — минимальный (проверка ожидаемых UCI-ходов), чтобы бэк-валидация
 * и фронт-диспетчер имели словарь `type`'ов, но детали контракта ещё
 * не зафиксированы — шейп будет уточнён в ADR итерации 2.
 */
export interface PositionStepPayload {
  type: 'position';
  fen: string;
  /**
   * Ожидаемые ходы (UCI). Принимается любой из списка.
   * KS-1983: опционально — отсутствие или пустой массив означает
   * read-only-позицию (шаг показывает диаграмму, без интерактивности).
   */
  expectedMoves?: string[];
  orientation?: 'white' | 'black';
}

/**
 * Разбор своей партии (итерация 3, L-30). Заглушка — детали payload'а
 * зафиксирует ADR итерации 3.
 */
export interface GameReviewStepPayload {
  type: 'game_review';
  /** id импортированной/сыгранной партии в нашей БД. */
  gameId?: string;
  /** Либо прямой PGN, если партия не загружена. */
  pgn?: string;
}

/**
 * Видео-шаг (итерация 3, L-34). Заглушка, появится если методически
 * понадобится.
 */
export interface VideoStepPayload {
  type: 'video';
  /** Внешний URL (YouTube/Vimeo). Рендер через iframe. */
  url: string;
  titleI18nKey?: string;
}

/**
 * Эндшпильный тренажёр (L-24 / KS-1800 frontend / KS-1815 backend-контракт).
 * Ученик играет позицию против Stockfish'а с ограниченным `skillLevel`.
 * Условие победы — дискриминированный union по `kind`:
 *   - `mate`              — поставить мат соперником
 *   - `promote`           — провести пешку в ферзи
 *   - `reach_position`    — достичь указанного FEN
 *   - `material_advantage` — материальное преимущество `amount` (в пешках)
 *
 * Shape согласован с frontend'ом; меняется только в связке с UI.
 */
export type EndgameWinCondition =
  | { kind: 'mate' }
  | { kind: 'promote' }
  | { kind: 'reach_position'; fen: string }
  | { kind: 'material_advantage'; amount: number };

export interface EndgameDrillStepPayload {
  type: 'endgame_drill';
  /** Стартовая позиция. Валидируется через chess.js. */
  fen: string;
  /** За какую сторону играет ученик. */
  playerSide: 'white' | 'black';
  /** UCI Skill Level Stockfish'а (0..20). */
  skillLevel: number;
  winCondition: EndgameWinCondition;
  /** Жёсткий лимит хода (защита от бесконечной партии). */
  maxMoves?: number;
  /** Разрешены ли подсказки движка. По умолчанию — false (фронт решает UX). */
  hintsAllowed?: boolean;
}

/**
 * Дебютный тренажёр (L-32 / KS-1801 frontend / KS-1816 backend).
 * Ученик играет дебют по PGN-дереву вариантов:
 *  - `show_correction` — при отклонении показать корректный ход и
 *    вернуть доску на предыдущую позицию;
 *  - `engine_punish`   — при отклонении Stockfish продолжает играть
 *    и «наказывает» ученика материально/позиционно.
 *
 * Shape согласован с фронтом.
 */
export type OpeningDeviationHandling = 'show_correction' | 'engine_punish';

export interface OpeningDrillStepPayload {
  type: 'opening_drill';
  /**
   * PGN-дерево дебютной линии с вариантами (в т.ч. вложенными).
   * Должно парситься базовым `chess.js#loadPgn` (основная линия ≥ 1 хода,
   * скобки вариантов сбалансированы).
   */
  pgn: string;
  /** За какую сторону играет ученик. */
  playerSide: 'white' | 'black';
  /** Как реагировать на уход из теории. */
  onDeviation: OpeningDeviationHandling;
  /**
   * UCI Skill Level Stockfish'а (0..20). Имеет смысл только при
   * `onDeviation === 'engine_punish'`, но для `show_correction` не
   * считается ошибкой — фронт может использовать значение по умолчанию.
   */
  engineSkillLevel?: number;
}

/**
 * KS-2249 (ADR-035 §11 / E6): корзина сложности для случайной выборки
 * drill'а из пула. Маппинг бакета на числовой `difficulty` (1..5) —
 * через константу `DRILL_BUCKET_TO_DIFFICULTY` ниже.
 *  - `easy`   — difficulty 1..2 (для первых уроков курса)
 *  - `medium` — difficulty 3
 *  - `hard`   — difficulty 4..5 (для проверки в конце темы)
 */
export type DrillDifficultyBucket = 'easy' | 'medium' | 'hard';

/**
 * KS-2315 (ADR-035 §11 / E6): связь корзина сложности → допустимые
 * значения `tactic_drills.difficulty` (1..5). Используется резолвером
 * `/tactic-drill/by-step/:stepId`:
 *   `WHERE difficulty IN (DRILL_BUCKET_TO_DIFFICULTY[bucket]) ORDER BY random()`
 *
 * При расширении методики (например, добавление difficulty 6 для
 * экспертных drill'ов) — менять только эту константу, поведение
 * резолвера и pickDrillForLesson остаётся прежним.
 */
export const DRILL_BUCKET_TO_DIFFICULTY: Record<
  DrillDifficultyBucket,
  readonly number[]
> = {
  easy:   [1, 2],
  medium: [3],
  hard:   [4, 5],
};

/**
 * KS-2249 (ADR-035 §11 / E6). Drill-шаг урока — `LessonStep.kind = 'drill'`.
 *
 * Drill-payload разрешает два сценария выбора позиции:
 *  1. **Fixed** — указан `drillId` (UUID конкретного drill'а из
 *     `tactic_drills`). Используется когда автор курса ссылается на
 *     известную позицию (например, классический пример на пин).
 *  2. **Random** — `drillId` не указан, drill случайно подбирается
 *     из пула по `drillType` (+ опц. `difficultyBucket`). Каждое
 *     прохождение шага даёт новый drill — отлично для повторного
 *     тренинга паттерна.
 *
 * Если переданы оба поля — приоритет у `drillId` (`difficultyBucket`
 * игнорируется backend'ом; для редактора это валидный, но избыточный
 * payload).
 *
 * Поле `count` управляет количеством drill'ов подряд в одном шаге
 * (default 1, max 10). При `count > 1` для каждой попытки backend
 * подбирает новый drill (для `mode='random'`) или возвращает один
 * и тот же drillId (для `mode='fixed'` — повторное прохождение
 * допустимо, рейтинг не растёт).
 */
export interface DrillStepPayload {
  type: 'drill';
  /**
   * Один из 8 drill-типов из methodology §2 (см. TacticDrillType).
   * Обязателен — фронт по нему выбирает UI (palette / single-square
   * / multi-square / number-pad / from-to-pad).
   */
  drillType: TacticDrillType;
  /**
   * UUID конкретного drill'а в `tactic_drills`. Опц. — без него
   * backend подберёт случайный drill заданного типа из пула.
   */
  drillId?: string;
  /**
   * Опц. бакет сложности для случайной выборки. Игнорируется если
   * `drillId` указан.
   */
  difficultyBucket?: DrillDifficultyBucket;
  /**
   * Сколько drill'ов нужно показать в шаге подряд. Default 1.
   * Допустимо 1..10. Имеет смысл при `mode='random'` — при
   * `drillId` все count покажут одну и ту же позицию.
   */
  count?: number;
  /**
   * Минимальное число решённых для зачёта шага. Default = `count`.
   * Должно быть в диапазоне `1..count`.
   */
  minSolved?: number;
}

/**
 * Дискриминированный union по полю `type`. Сужать через `switch (payload.type)`.
 */
export type StepPayload =
  | TextStepPayload
  | PuzzleStepPayload
  | QuizStepPayload
  | PositionStepPayload
  | GameReviewStepPayload
  | VideoStepPayload
  | EndgameDrillStepPayload
  | OpeningDrillStepPayload
  | DrillStepPayload;

/** Алиасы под именование в ТЗ (`TextStep`/`PuzzleStep`/`QuizStep`). */
export type TextStep = TextStepPayload;
export type PuzzleStep = PuzzleStepPayload;
export type QuizStep = QuizStepPayload;
export type PositionStep = PositionStepPayload;
export type GameReviewStep = GameReviewStepPayload;
export type VideoStep = VideoStepPayload;
export type EndgameDrillStep = EndgameDrillStepPayload;
export type OpeningDrillStep = OpeningDrillStepPayload;
export type DrillStep = DrillStepPayload;

// ─── Domain entities (API shape, сериализовано в JSON) ────────────────

/**
 * Поля курса для UI-карточки (KS-1931 §8.1, KS-1933 / KS-1934).
 * Все опциональные / nullable, чтобы не ломать существующие курсы и
 * пользовательские курсы без обогащения. `descriptionI18nKey` (в
 * системных курсах) или `description` (в пользовательских) остаются
 * как fallback для поля «о курсе».
 *
 * Используется как mixin для системного `Course` / `CourseListItem`
 * (см. ниже) и для `UserEnrolledCourseDto` (см. ./user-courses.ts).
 */
export interface CourseCardFields {
  /** Путь к обложке (S3 / static). */
  coverUrl?: string | null;
  /** Звёзды сложности внутри уровня: 1=easy, 2=medium, 3=hard. */
  difficulty?: 1 | 2 | 3 | null;
  /** Оценка времени на курс (минут). */
  estimatedMinutes?: number | null;
  /** i18n-ключ описания целевой аудитории («для кого»). */
  audienceI18nKey?: string | null;
  /** i18n-ключ крючка тизера («что научишься»). */
  hookI18nKey?: string | null;
  /** i18n-ключ результата («что в финале»). */
  outcomeI18nKey?: string | null;
  /** Произвольные теги курса (`endgame`, `tactics`, ...). */
  tags?: string[] | null;
}

/**
 * KS-1964/KS-1965 (Admin API B-2/B-3): inline-поля курса. Источник —
 * новые колонки `Course.{title,description,audience,hook,outcome}` в
 * Prisma. Заполняются админкой; имеют **приоритет** над i18n-ключами
 * (`titleKey`, `descriptionKey`, `audience/hook/outcomeI18nKey`),
 * которые остаются как fallback для seed-курсов и совместимости.
 *
 * Контракт для UI:
 * ```
 * const title = course.title ?? t(course.titleI18nKey);
 * const description = course.description ?? t(course.descriptionI18nKey);
 * const audience = course.audience ?? (course.audienceI18nKey ? t(course.audienceI18nKey) : null);
 * // и т. д. для hook / outcome
 * ```
 *
 * Inline-поля nullable: `null` → fallback на i18n-ключ. `undefined` (на
 * клиенте до парсинга/обновления) — обрабатывать так же, как `null`.
 */
export interface CourseInlineFields {
  /** Inline-заголовок курса. Приоритет над `titleI18nKey`. */
  title?: string | null;
  /** Inline-описание курса. Приоритет над `descriptionI18nKey`. */
  description?: string | null;
  /** Inline «для кого». Приоритет над `audienceI18nKey`. */
  audience?: string | null;
  /** Inline «что научишься». Приоритет над `hookI18nKey`. */
  hook?: string | null;
  /** Inline «что в финале». Приоритет над `outcomeI18nKey`. */
  outcome?: string | null;
}

/**
 * Курс. Поля соответствуют Prisma-модели `Course` (см. lessons-module.md §2.1
 * и будущую миграцию L-03). `titleI18nKey` / `descriptionI18nKey` —
 * ссылки на словари i18n. Параллельно поддерживаются inline-поля
 * (`CourseInlineFields`, KS-1964/B-3): admin API заполняет их строкой,
 * UI берёт inline в приоритете и использует i18n-ключ как fallback.
 */
export interface Course extends CourseCardFields, CourseInlineFields {
  id: string;
  slug: string;
  level: CourseLevel;
  titleI18nKey: string;
  descriptionI18nKey: string;
  order: number;
  isPublished: boolean;
  /** Сколько уроков в курсе (агрегат — не отдельная таблица). */
  lessonCount: number;
  /**
   * KS-2037: упорядоченный список `blockKey` уроков курса
   * (см. `Lesson.blockKey`). Снимает хардкод `BLOCK_ORDER` с фронта
   * (`apps/web/src/components/lessons/courseBlocks.ts`). Если массив
   * пуст — порядок блоков по умолчанию (фронт сам сортирует:
   * алфавит / min(order)). Если у курса есть `blockKey`, отсутствующий
   * в `blockOrder`, фронт рендерит его после известных.
   */
  blockOrder: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * KS-1964/KS-1965 (Admin API B-2/B-3): inline-поля урока. Источник —
 * новые колонки `Lesson.{title,summary}`. Имеют приоритет над
 * `titleI18nKey` / `summaryI18nKey`, которые остаются как fallback.
 *
 * Контракт для UI:
 * ```
 * const title = lesson.title ?? t(lesson.titleI18nKey);
 * const summary = lesson.summary ?? t(lesson.summaryI18nKey);
 * ```
 */
export interface LessonInlineFields {
  /** Inline-заголовок урока. Приоритет над `titleI18nKey`. */
  title?: string | null;
  /** Inline-summary урока. Приоритет над `summaryI18nKey`. */
  summary?: string | null;
}

/**
 * Урок. `payload` урока — параметры высокого уровня (например, подборка
 * `puzzleIds` на уровне всего урока); детализация — в `LessonStep.payload`.
 * Семантика `payload` зависит от `kind` и фиксируется отдельно в ADR-024.
 */
export interface Lesson extends LessonInlineFields {
  id: string;
  courseId: string;
  slug: string;
  order: number;
  kind: LessonKind;
  titleI18nKey: string;
  summaryI18nKey: string;
  /** Опциональные параметры уровня урока (подборка puzzleIds, ссылки и т. п.). */
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Шаг урока. Дискриминатор — `type`, полная shape'а payload'а — в
 * `StepPayload`. Для бэка `payload` хранится как JSONB.
 */
export interface LessonStep {
  id: string;
  lessonId: string;
  order: number;
  type: LessonStepType;
  /** Дискриминируется по `type`. */
  payload: StepPayload;
}

// ─── User progress ────────────────────────────────────────────────────

/**
 * Прогресс пользователя по курсу.
 * `startedAt`/`completedAt` — ISO-строки (в БД `DateTime`, сериализуется).
 */
export interface UserCourseProgress {
  userId: string;
  courseId: string;
  startedAt: string;
  completedAt: string | null;
  currentLessonId: string | null;
  /** Сколько уроков пройдено (для индикатора в `CoursePage`). */
  lessonsCompleted: number;
  /** Всего уроков на момент последнего апдейта — для UI, не для хранения. */
  lessonsTotal: number;
  /**
   * KS-1955: ISO-строка момента последней активности по курсу.
   * MAX из `UserCourseProgress.updatedAt` и `UserLessonProgress.updatedAt`
   * по урокам этого курса. Используется в Hero Variant B
   * («Последняя активность: N дней назад»).
   */
  lastActivityAt: string;
  /**
   * KS-1955: первый незавершённый урок курса по `order` ASC. `null`,
   * если курс пройден. Поля повторены в `CourseListItem.progress`.
   */
  currentLessonSlug: string | null;
  /**
   * KS-2148: inline-заголовок текущего урока из `Lesson.title` (KS-1964),
   * симметрично `CourseListItem.progress.currentLessonTitle` и
   * `ActiveSystemCourseDto.currentLessonTitle`. UI fallback в порядке
   * title → i18nKey → slug — раньше при отсутствии ключа в
   * `translation.json` пользователь видел сырой `mate-bishop-knight`.
   */
  currentLessonTitle: string | null;
  currentLessonTitleI18nKey: string | null;
  /** Порядковый номер текущего урока, 1-based — для «Урок N из M». */
  currentLessonOrder: number | null;
}

/**
 * Прогресс пользователя по уроку. `stepsState` — агрегат по шагам
 * (попытки задач пишутся в `PuzzleAttempt`, здесь только итоговое состояние
 * каждого шага).
 */
export interface UserLessonProgress {
  userId: string;
  lessonId: string;
  startedAt: string;
  completedAt: string | null;
  /** Итоговый балл за урок 0..1 (напр. доля пройденных шагов). */
  score: number | null;
  stepsState: Record<string, LessonStepState>;
}

// ─── REST DTOs ────────────────────────────────────────────────────────
//
// Формат путей — предположительный, уточняется в L-04. Согласование
// имён/полей — ответственность shared-пакета.

/** GET /api/lessons/courses — список курсов (без уроков). */
export interface CourseListItem extends CourseCardFields, CourseInlineFields {
  id: string;
  slug: string;
  level: CourseLevel;
  titleI18nKey: string;
  descriptionI18nKey: string;
  order: number;
  lessonCount: number;
  /**
   * KS-2037: упорядоченный список `blockKey` уроков курса (см. `Course.blockOrder`).
   * Возвращается всегда, даже если пуст — фронт сам решает fallback.
   */
  blockOrder: string[];
  /** Прогресс текущего пользователя, если он аутентифицирован. */
  progress?: {
    lessonsCompleted: number;
    startedAt: string;
    completedAt: string | null;
    currentLessonId: string | null;
    /**
     * KS-1955: момент последней активности (MAX из progress.updatedAt
     * курса и updatedAt всех его UserLessonProgress). Используется в
     * Hero Variant B для бейджа «Последняя активность: N дней назад».
     */
    lastActivityAt: string;
    /**
     * KS-1955: первый незавершённый урок по `order` ASC.
     * `null`, если курс пройден.
     */
    currentLessonSlug: string | null;
    /**
     * KS-2148: inline-заголовок текущего урока из `Lesson.title` (KS-1964).
     * Парный к `currentLessonTitleI18nKey` — если ключ отсутствует в
     * `translation.json`, UI показывает inline вместо fallback'а на slug.
     * `null` если у урока нет inline title или нет current lesson.
     */
    currentLessonTitle: string | null;
    currentLessonTitleI18nKey: string | null;
    /** 1-based номер текущего урока — для «Урок N из M». */
    currentLessonOrder: number | null;
  } | null;
}

export interface CourseListResponse {
  data: CourseListItem[];
  /** Рекомендованный уровень для текущего пользователя (по ratingPuzzle). */
  recommendedLevel?: CourseLevel;
}

/** GET /api/lessons/courses/:slug — курс + короткий список уроков. */
export interface CourseWithLessonsResponse {
  course: Course;
  lessons: CourseLessonSummary[];
  progress?: UserCourseProgress | null;
}

/** Короткая сводка урока для `CoursePage`. */
export interface CourseLessonSummary extends LessonInlineFields {
  id: string;
  slug: string;
  order: number;
  /**
   * Ключ блока внутри курса (`rules`, `basic-mates`, …).
   * Соответствует `Lesson.blockKey` из БД. Фронт использует для
   * группировки уроков по блокам на `CoursePage` (см. KS-1785/KS-1790).
   */
  blockKey: string;
  kind: LessonKind;
  titleI18nKey: string;
  summaryI18nKey: string;
  stepCount: number;
  /**
   * KS-1992: сколько шагов урока пользователь пометил `done` (count
   * по `stepsState` в `UserLessonProgress`). Для анонимного запроса
   * либо для урока без прогресса — `0`. Используется в карточке
   * урока на странице курса для показа «N/M шагов».
   */
  completedStepsCount: number;
  /** Состояние прохождения пользователем. */
  progressState: 'not_started' | 'in_progress' | 'completed';
  /**
   * Когда урок «освоен» (score ≥ 80, ADR-025 §2.5). ISO. Передаётся
   * только если `userId` авторизован и урок освоен. Используется для
   * бейджа «Освоено» на `CoursePage` (L-22).
   */
  masteredAt?: string | null;
  /**
   * Ближайший плановый повтор SM-2 (`LessonReview.dueAt`). ISO.
   * Передаётся, если урок освоен и для него есть запись в
   * `LessonReview`. Используется для бейджа «К повторению».
   */
  dueAt?: string | null;
}

/** GET /api/lessons/courses/:courseSlug/lessons/:lessonSlug — урок с шагами. */
export interface LessonWithStepsResponse {
  lesson: Lesson;
  steps: LessonStep[];
  progress?: UserLessonProgress | null;
}

/** POST /api/lessons/:lessonId/progress/start — начать/возобновить урок. */
export type StartLessonProgressResponse = UserLessonProgress;

/**
 * POST /api/lessons/progress/step — обновить состояние одного шага.
 *
 * Фактический путь эндпоинта — `/api/lessons/progress/step` (без
 * `lessonId` в URL), поэтому `lessonId` передаётся в body. Поле
 * обязательное и требуется class-validator DTO на бэке.
 */
export interface UpdateLessonStepRequest {
  lessonId: string;
  stepId: string;
  state: LessonStepState;
  /** Опциональные метрики шага (напр. доля верных ответов для `quiz`). */
  score?: number;
}

export type UpdateLessonStepResponse = UserLessonProgress;

/**
 * POST /api/lessons/progress/lesson/complete — завершить урок (≥70%).
 * `lessonId` передаётся в body (см. комментарий к `UpdateLessonStepRequest`).
 */
export interface CompleteLessonRequest {
  lessonId: string;
  /** Финальный балл 0..1 (обычно агрегат `stepsState`). */
  score: number;
  /**
   * SM-2 quality 0..5. Опциональное переопределение. Если не передан —
   * бэкенд вычисляет из `score` через `Sm2Service.scoreToQuality`. Используется
   * UI повторений (L-22), где ученик явно оценивает «как пошло» после
   * повторного прохождения (0 — не помню, 5 — легко).
   */
  quality?: number;
}

/**
 * Ответ на `POST /api/lessons/progress/lesson/complete`. Базово — состояние
 * `UserLessonProgress`; при освоении урока (score ≥ 80 либо переданный
 * `quality ≥ 3`) дополнительно отдаются параметры SM-2 для экрана
 * результата («следующий повтор через N дней»).
 */
export interface CompleteLessonResponse extends UserLessonProgress {
  /** ISO плановой даты следующего повтора SM-2. `null` если повторы не планировались. */
  nextDueAt?: string | null;
  /** Интервал до следующего повтора в днях (SM-2 `interval`). */
  intervalDays?: number;
  /** Коэффициент лёгкости SM-2 (`easiness`). */
  easeFactor?: number;
}

/** GET /api/lessons/recommendation — рекомендованный уровень (по `ratingPuzzle`). */
export interface CourseRecommendationResponse {
  level: CourseLevel;
  /** На чём основана рекомендация (для UI-пояснения). */
  reason: 'rating_puzzle' | 'default';
  ratingPuzzle?: number;
}

// ─── Active courses aggregate (KS-1937) ──────────────────────────────
//
// `GET /api/lessons/active-courses` — один запрос вместо двух
// (`listCourses` + `listEnrolled`) для Hero и `/lessons/my-active`.
// Возвращает курсы пользователя с активным прогрессом
// (`progress != null && completedAt == null`) из двух источников:
// системных (`Course` + `UserCourseProgress`) и enrolled-чужих
// пользовательских (`UserCourse` + `UserCoursePlayProgress`).
//
// Кастомные собственные курсы автора (`UserCourse where ownerId = me`)
// в выборку НЕ попадают — концепт §3.3 не считает их «активным
// обучением» (это редактирование автора, а не прохождение).
//
// Сортировка: `lastActivityAt` DESC (свежее наверху). Сам maximum
// активных курсов на пользователя — низкий (десятки в худшем случае),
// поэтому пагинация в MVP не предусмотрена.

/** Активный системный курс (источник истины — `Course` + `UserCourseProgress`). */
export interface ActiveSystemCourseDto extends CourseCardFields, CourseInlineFields {
  kind: 'system';
  id: string;
  slug: string;
  level: CourseLevel;
  titleI18nKey: string;
  /** i18n-ключ описания курса (fallback к hookI18nKey/audienceI18nKey на UI). */
  descriptionI18nKey: string;
  lessonCount: number;
  /** Сколько уроков курса пройдено (UserLessonProgress.completedAt != null). */
  lessonsCompleted: number;
  /** ISO-8601: MAX(courseProgress.updatedAt, lessonProgress.updatedAt). */
  lastActivityAt: string;
  /** Первый незавершённый урок курса по `order` ASC. */
  currentLessonSlug: string | null;
  /**
   * KS-2148: inline-заголовок текущего урока из `Lesson.title` (KS-1964).
   * Симметрично `ActiveEnrolledCourseDto.currentLessonTitle`. UI
   * использует inline когда `currentLessonTitleI18nKey` отсутствует в
   * `translation.json` (вместо fallback'а на slug — пользователь видел
   * `mate-bishop-knight` вместо «Мат слоном и конём»).
   */
  currentLessonTitle: string | null;
  currentLessonTitleI18nKey: string | null;
  currentLessonOrder: number | null;
  /**
   * KS-2037: порядок блоков курса (см. `Course.blockOrder`). Возвращается
   * всегда; для курсов без значения — пустой массив.
   */
  blockOrder: string[];
}

/**
 * Активный enrolled-курс — чужой пользовательский курс, который текущий
 * юзер начал проходить. Источник — `UserCourse` + `UserCoursePlayProgress`.
 *
 * У `UserCourse` нет `level` / `i18nKey`-ов; заголовок хранится строкой.
 * Поля `CourseCardFields` (`coverUrl`/`difficulty`/`tags`/...) сейчас
 * пустые — у пользовательских курсов в БД таких колонок нет (KS-1935).
 */
export interface ActiveEnrolledCourseDto {
  kind: 'enrolled';
  id: string;
  slug: string;
  /** Заголовок курса как сырая строка (UserCourse.title). */
  title: string;
  /** Описание курса (UserCourse.description), может быть null. */
  description: string | null;
  /** Автор курса — для подписи «от @username» в карточке. */
  ownerId: string;
  lessonCount: number;
  /** UserCoursePlayProgress.completedLessonsCount. */
  lessonsCompleted: number;
  /** ISO-8601: UserCoursePlayProgress.lastActivityAt. */
  lastActivityAt: string;
  /** Первый незавершённый урок курса по `order` ASC (UserLesson.id). */
  currentLessonSlug: string | null;
  currentLessonTitle: string | null;
  currentLessonOrder: number | null;
}

/** Дискриминированный union: фронт сужает по `kind`. */
export type ActiveCourseDto = ActiveSystemCourseDto | ActiveEnrolledCourseDto;

/** GET /api/lessons/active-courses. */
export interface ActiveCoursesResponse {
  data: ActiveCourseDto[];
}

// ─── SM-2 Reviews (L-22 / KS-1799, shared contract KS-1809) ──────────
//
// Источник правил — ADR-025. `LessonReview` планируется `Sm2Service` и
// выдаётся `GET /api/lessons/reviews/due`. UI повторений (L-22) потребляет
// именно эти типы, не лезет в `Sm2Service` напрямую.

/** Одна строка списка «к повторению сегодня». */
export interface ReviewDueItem {
  courseSlug: string;
  /**
   * KS-2148: inline-заголовок курса из `Course.title` (если есть).
   * UI использует inline когда `courseTitleI18nKey` отсутствует в
   * `translation.json`. `null` если у курса нет inline title.
   */
  courseTitle: string | null;
  courseTitleI18nKey: string;
  lessonSlug: string;
  /**
   * KS-2148: inline-заголовок урока из `Lesson.title` (KS-1964).
   * UI использует inline когда `lessonTitleI18nKey` отсутствует.
   * `null` если у урока нет inline title.
   */
  lessonTitle: string | null;
  lessonTitleI18nKey: string;
  /** ISO — когда плановый повтор стал/станет доступен. */
  dueAt: string;
  /** ISO — когда урок повторяли последний раз (null для нового повтора). */
  lastReviewedAt: string | null;
  /** Текущий SM-2 `interval` в днях. */
  intervalDays: number;
}

/**
 * GET /api/lessons/reviews/due — список уроков, у которых `dueAt <= now`
 * для текущего пользователя. Используется экраном повторений (L-22).
 */
export interface ReviewsDueResponse {
  items: ReviewDueItem[];
}

// ─── Mistakes journal (L-31 / KS-1802) ────────────────────────────────
//
// Дневник ошибок. Агрегирует `puzzle`-неудачи и ходы, классифицированные
// движком как `mistake` / `blunder` в разборе партии. Используется для
// рекомендаций «повторить темы X, Y».

/**
 * Источник ошибки.
 *  - `puzzle` — неправильная попытка в `PuzzleAttempt`.
 *  - `game_review` — ход классифицирован как `mistake`/`blunder` в анализе
 *    партии (KS-2433: авто-генерация отчёта через Stockfish удалена;
 *    источник остаётся для совместимости с историческими записями
 *    `UserMistake`).
 */
export type UserMistakeSource = 'puzzle' | 'game_review';

/**
 * Запись о единичной ошибке. Отдаётся `GET /api/lessons/mistakes/recent`
 * (если потребуется фронту; MVP endpoints — aggregates / recommendations).
 */
export interface UserMistake {
  id: string;
  userId: string;
  source: UserMistakeSource;
  puzzleId: string | null;
  gameId: string | null;
  ply: number | null;
  themes: PuzzleTheme[];
  occurredAt: string; // ISO
}

/**
 * Агрегат «тема — сколько раз ошибался — когда последний раз».
 * Сортировка в ответе: по убыванию `count`, при равенстве — по убыванию
 * `lastOccurredAt`.
 */
export interface UserMistakeAggregate {
  theme: PuzzleTheme;
  count: number;
  lastOccurredAt: string; // ISO
}

/**
 * GET /api/lessons/mistakes/aggregates?since=ISO&limit=N
 *
 * `since` (опц.) — ISO-cutoff, учитывать только ошибки `occurredAt >= since`.
 * По умолчанию — все ошибки пользователя.
 * `limit` (опц.) — обрезать топ-N по `count` (default 20, max 50).
 */
export interface UserMistakeAggregatesResponse {
  aggregates: UserMistakeAggregate[];
  /** Сколько всего уникальных тем, даже если `limit` обрезал список. */
  totalThemes: number;
  /** Отражение использованных фильтров (для UI). */
  since: string | null;
  limit: number;
}

/**
 * Одна рекомендация из топ-N проблемных тем. `puzzleStep` — готовый
 * `PuzzleStepPayload` типа `filter`, который фронт может передать в API
 * L-06 (`PuzzleService.findPuzzles`) без дополнительной подготовки.
 */
export interface UserMistakeRecommendation {
  theme: PuzzleTheme;
  /** Сколько ошибок по теме за окно рекомендаций (см. `windowDays`). */
  mistakeCount: number;
  /** Когда последний раз ошибался. */
  lastOccurredAt: string; // ISO
  /** Готовый payload для запуска тренировочного сета. */
  puzzleStep: PuzzleStepPayload;
}

/**
 * GET /api/lessons/mistakes/recommendations
 *
 * Возвращает топ-3 тем, по которым пользователь больше всего ошибался
 * за последние `windowDays` дней (default 30), с payload'ом-заглушкой
 * для `PuzzleStep` (фильтр по теме + `ratingPuzzle ± ratingRange`).
 */
export interface UserMistakeRecommendationsResponse {
  recommendations: UserMistakeRecommendation[];
  /** Рейтинг пользователя, на основе которого сформированы диапазоны. */
  ratingPuzzle: number;
  /** Ширина окна агрегации в днях. */
  windowDays: number;
  /** Ширина рейтингового диапазона (± от `ratingPuzzle`). */
  ratingRange: number;
}
