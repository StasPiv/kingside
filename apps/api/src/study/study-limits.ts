/**
 * KS-2815 / ADR-059 §B.2 (KS-2818 T3). Лимиты на ресурсы Studies.
 *
 * Цель — единый источник истины для сервиса, тестов и фронтовых
 * подсказок «достигнут лимит». Все значения согласованы в §B.2 KS-2815.
 */
export const STUDY_LIMITS = {
  /** Максимум студий у одного пользователя (по аналогии с `coursesPerUser=20`). */
  studiesPerUser: 20,
  /** Максимум глав в одной студии (совпадает с Lichess). */
  chaptersPerStudy: 64,
  /**
   * Максимальный размер PGN-блока одной главы, в байтах.
   * 256 КБ хватает с большим запасом на дерево с вариантами,
   * стрелками, комментариями и NAG-аннотациями.
   */
  chapterPgnMaxBytes: 256 * 1024,
  /** Максимальная длина имени студии. */
  studyNameMaxLength: 200,
  /** Максимальная длина описания студии. */
  studyDescriptionMaxLength: 5000,
  /** Максимальная длина имени главы. */
  chapterNameMaxLength: 200,
  /** Максимальная длина FEN-стартовой позиции (грубая проверка формата). */
  startFenMaxLength: 100,
} as const;

/** Разрешённые ориентации доски в главе. */
export const STUDY_CHAPTER_ORIENTATIONS = ['white', 'black'] as const;
export type StudyChapterOrientation =
  (typeof STUDY_CHAPTER_ORIENTATIONS)[number];

/**
 * Разрешённые режимы главы. KS-2856 / ADR-060 §2.2 — Phase 2 включает
 * все четыре режима. См. `study.service.ts` / валидаторы DTO.
 */
export const STUDY_CHAPTER_MODES = [
  'analysis',
  'practice',
  'conceal',
  'gamebook',
] as const;
export type StudyChapterMode = (typeof STUDY_CHAPTER_MODES)[number];

/**
 * KS-2856 / ADR-060 §3.2. Whitelist значений `Study.visibility`.
 * См. ADR-060 §2.6 — `private` (default) | `unlisted` (по ссылке,
 * не в каталоге) | `public` (в каталоге).
 */
export const STUDY_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type StudyVisibility = (typeof STUDY_VISIBILITIES)[number];

/**
 * KS-2856 / ADR-060 §3.2. Роли в `study_members`. `spectator`
 * (читатель публичной студии) — implicit, в таблице не хранится.
 */
export const STUDY_MEMBER_ROLES = ['owner', 'contributor'] as const;
export type StudyMemberRole = (typeof STUDY_MEMBER_ROLES)[number];

/** KS-2856 / ADR-060 §3.4. Лимит длины/количества topics. */
export const STUDY_TOPIC_MAX = 5;
export const STUDY_TOPIC_LENGTH_MAX = 30;

/**
 * KS-2856 / ADR-060 §3.3 R4. Лимиты gamebook payload'а.
 * Защита от перенасыщения главы текстом (DDoS storage + лента
 * редактора).
 */
export const GAMEBOOK_LIMITS = {
  /** Максимум узлов с инструкциями (записей в `byUci`). */
  maxNodes: 200,
  /** Длина intro-текста. */
  introMaxLength: 2000,
  /** Длина hint / success / failure на узел. */
  textPerNodeMaxLength: 500,
} as const;

/**
 * Шаг между `orderIdx` соседних глав при создании. Большой шаг (1000)
 * позволяет drag-n-drop вставлять между N и N+1, выставляя новый
 * orderIdx равный `(N + N+1) / 2`, без переписи всех соседей.
 */
export const STUDY_ORDER_STEP = 1000;
