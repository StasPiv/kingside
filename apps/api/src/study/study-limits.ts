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
 * Разрешённые режимы главы. В MVP — только `analysis`; whitelist на
 * будущее (`practice`, `conceal`, `gamebook`) пока не активирован.
 */
export const STUDY_CHAPTER_MODES = ['analysis'] as const;
export type StudyChapterMode = (typeof STUDY_CHAPTER_MODES)[number];

/**
 * Шаг между `orderIdx` соседних глав при создании. Большой шаг (1000)
 * позволяет drag-n-drop вставлять между N и N+1, выставляя новый
 * orderIdx равный `(N + N+1) / 2`, без переписи всех соседей.
 */
export const STUDY_ORDER_STEP = 1000;
