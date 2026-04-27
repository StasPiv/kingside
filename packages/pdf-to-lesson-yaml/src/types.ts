/**
 * KS-2045 — типы AST и конфига конвертера PDF → YAML lesson-format.
 *
 * AST — промежуточное представление, эмитится Python-extractor'ом
 * (`src/python/extract_pdf.py`). TS-transformer переводит AST в
 * lesson-format (KS-2015) и сериализует в YAML.
 */

// ─── AST из Python-extractor'а ───────────────────────────────────────────

export interface PdfHeadingBlock {
  kind: 'heading';
  /** 1 — Глава/Часть, 2 — параграф/подраздел, 3 — внутренняя секция. */
  level: 1 | 2 | 3;
  text: string;
  page: number;
  bbox: [number, number, number, number];
}

export interface PdfProseBlock {
  kind: 'prose';
  text: string;
  page: number;
  bbox: [number, number, number, number];
}

export interface PdfDiagramBlock {
  kind: 'diagram';
  /** Только board-часть FEN (`rnbqkbnr/...`). */
  fen_board: string;
  /** Полный FEN с фиксированным `w - - 0 1`. Stage 1 не угадывает права рокировки/side. */
  fen: string;
  page: number;
  /** Номер диаграммы по диапазону страниц (1-indexed). */
  diagramIndex: number;
  bbox: [number, number, number, number];
}

export type PdfBlock = PdfHeadingBlock | PdfProseBlock | PdfDiagramBlock;

export interface PdfExtractResult {
  pageRange: [number, number];
  blocks: PdfBlock[];
}

// ─── Конфиг конвертера ───────────────────────────────────────────────────

export interface ConverterCourseConfig {
  slug: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  difficulty?: 1 | 2 | 3;
  estimatedMinutes?: number;
  titleKey: string;
  descriptionKey: string;
  title?: string;
  description?: string;
  isPublished?: boolean;
  tags?: string[];
  /** KS-2037: упорядоченный список blockKey'ев в курсе. */
  blockOrder?: string[];
  /** Для записи в `course.yml` — путь к PDF (опционально). */
  audienceI18nKey?: string | null;
  hookI18nKey?: string | null;
  outcomeI18nKey?: string | null;
}

export interface ConverterChapterConfig {
  /** Заголовок главы (для `lesson.title`). */
  title: string;
  /** Slug для урока. */
  slug: string;
  /** Диапазон страниц PDF (1-indexed, inclusive). */
  pageRange: [number, number];
  /** blockKey урока (см. `Lesson.blockKey`). */
  blockKey: string;
  /** Тип урока (`Lesson.kind`). */
  kind: 'theory' | 'tactics_set' | 'endgame_set' | 'opening_line' | 'game_review' | 'quiz';
  /** Порядковый номер в курсе. */
  order: number;
  /** Опционально — расчётное время в минутах. */
  estMinutes?: number;
  /** i18n-ключи. */
  titleKey: string;
  summaryKey: string;
  /** Опционально — короткое описание урока. */
  summary?: string;
  isPublished?: boolean;
  /** Если true — не разбивать на шаги по headings, оставить один text-шаг. */
  singleStep?: boolean;
}

export interface ConverterConfig {
  course: ConverterCourseConfig;
  /**
   * Путь к PDF (относительный к converter-config.yml; либо абсолютный).
   * Может быть переопределён CLI-аргументом.
   */
  source?: {
    pdf?: string;
    language?: 'ru' | 'en';
  };
  chapters: ConverterChapterConfig[];
}

// ─── Lesson YAML (упрощённое представление, см. lesson.schema.json) ──────
//
// Для Stage 1 эмитим только `text` шаги. Полные типы — в KS-2015 / lesson-schema.

export interface YamlTextDiagram {
  fen: string;
  orientation?: 'white' | 'black';
}

export interface YamlTextStep {
  type: 'text';
  bodyMarkdown: string;
  diagrams?: YamlTextDiagram[];
}

export interface YamlGameReviewStep {
  type: 'game_review';
  pgn: string;
}

export type YamlStep = YamlTextStep | YamlGameReviewStep;

export interface YamlLessonFile {
  schemaVersion: 1;
  courseSlug: string;
  slug: string;
  order: number;
  blockKey: string;
  kind: ConverterChapterConfig['kind'];
  isPublished?: boolean;
  titleKey: string;
  summaryKey: string;
  title?: string;
  summary?: string;
  estMinutes?: number;
  steps: YamlStep[];
}

export interface YamlCourseFile {
  schemaVersion: 1;
  slug: string;
  level: ConverterCourseConfig['level'];
  order?: number;
  isPublished?: boolean;
  titleKey: string;
  descriptionKey: string;
  audienceI18nKey?: string | null;
  hookI18nKey?: string | null;
  outcomeI18nKey?: string | null;
  title?: string;
  description?: string;
  difficulty?: 1 | 2 | 3;
  estimatedMinutes?: number;
  tags?: string[];
  blockOrder?: string[];
}
