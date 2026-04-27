/**
 * KS-2017 / B-1 — внутренние типы CLI lesson-import.
 *
 * Структуры намеренно слабо-типизированы (`Record<string, unknown>`),
 * потому что AJV-валидатор уже проверил соответствие схеме.
 * Сильная типизация payload-шагов появится либо после генерации .d.ts из
 * JSON Schema (json-schema-to-typescript), либо после стабилизации
 * shared LessonStep-типов.
 */

export interface ParsedCourseFile {
  /** Абсолютный путь файла на диске. */
  path: string;
  /** Распарсенный YAML, прошедший courseSchema. */
  data: CourseFileData;
}

export interface ParsedLessonFile {
  path: string;
  data: LessonFileData;
}

export interface CourseFileData {
  schemaVersion: 1;
  slug: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  order?: number;
  isPublished?: boolean;
  titleKey: string;
  descriptionKey: string;
  audienceI18nKey?: string | null;
  hookI18nKey?: string | null;
  outcomeI18nKey?: string | null;
  title?: string | null;
  description?: string | null;
  audience?: string | null;
  hook?: string | null;
  outcome?: string | null;
  coverUrl?: string | null;
  difficulty?: 1 | 2 | 3;
  estimatedMinutes?: number | null;
  tags?: string[];
}

export interface LessonFileData {
  schemaVersion: 1;
  courseSlug: string;
  slug: string;
  order: number;
  blockKey: string;
  kind: 'theory' | 'tactics_set' | 'endgame_set' | 'opening_line' | 'game_review' | 'quiz';
  isPublished?: boolean;
  titleKey: string;
  summaryKey: string;
  title?: string | null;
  summary?: string | null;
  estMinutes?: number;
  steps: LessonStepData[];
}

export interface LessonStepData {
  type: string;
  [field: string]: unknown;
}

/**
 * Результат парсинга директории/одиночного файла.
 *  - либо course + N lessons,
 *  - либо просто 1 lesson (без course.yml).
 */
export interface ParsedBundle {
  course?: ParsedCourseFile;
  lessons: ParsedLessonFile[];
}

/** AJV-ошибка с пометкой, в каком файле/шаге она произошла. */
export interface DescribedError {
  /** Файл, где найдена ошибка (абсолютный путь). */
  file: string;
  /** JSON-pointer-like путь до проблемного поля. */
  instancePath: string;
  /** Оригинальное сообщение AJV. */
  message: string;
  /** Имя schema-keyword'а (`required`, `enum`, `pattern`, `oneOf`, `const`, …). */
  keyword: string;
  /** Доп. контекст (например, ожидаемые enum-значения). */
  params?: Record<string, unknown>;
}

/**
 * Состояние БД, как его отдаёт публичный/админский API. Используется как
 * baseline для diff'а в dry-run / import.
 */
export interface DbCourseSnapshot {
  id: string;
  slug: string;
  /** Уроки курса в админ-расширенном представлении. */
  lessons: DbLessonSnapshot[];
}

export interface DbLessonSnapshot {
  id: string;
  slug: string;
  order: number;
  steps: DbStepSnapshot[];
  /** Произвольные мета-поля, которые отдаст API; не валидируются строго. */
  [field: string]: unknown;
}

export interface DbStepSnapshot {
  id: string;
  order: number;
  type: string;
  payload: Record<string, unknown>;
}

/** Действие, которое импортер выполнит над одним шагом. */
export type StepAction = 'create' | 'update' | 'delete' | 'unchanged';

export interface StepDiffEntry {
  /** Order шага в новом файле (для unchanged/update/create) либо в БД (для delete). */
  order: number;
  type: string;
  action: StepAction;
  /** Краткое пояснение, что меняется (для UI). */
  details?: string;
}

export interface LessonDiff {
  /** slug урока. */
  slug: string;
  /** Что произошло с самим уроком (метаданные). */
  lessonAction: 'create' | 'update' | 'unchanged';
  /** Поля, которые изменились (только для update). */
  changedLessonFields?: string[];
  /** Diff по шагам (упорядочен 1..N в новом файле, потом delete'ы из БД хвостом). */
  steps: StepDiffEntry[];
}

export interface BundleDiff {
  course: {
    slug: string;
    action: 'create' | 'update' | 'unchanged';
    changedFields?: string[];
  } | null;
  lessons: LessonDiff[];
}
