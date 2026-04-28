import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { CourseLevel, LessonKind } from '@kingside/shared';
import {
  STEP_PAYLOAD_SUBTYPES,
  type StepPayloadDto,
} from '../../dto/step-payload.dto';

/**
 * KS-2018 / B-3 — DTO `POST /lessons/admin/import`.
 *
 * Контракт берётся из ADR `KS-2015-lesson-file-format.md` §4 / §5:
 *   {
 *     course?: <ImportCoursePayloadDto>,
 *     lesson:  <ImportLessonPayloadDto>,
 *     dryRun?: boolean
 *   }
 *
 * Поля курса и урока — зеркало `CreateAdminCourseDto` /
 * `CreateAdminLessonDto`, без наследования (наследование class-validator
 * DTO работает, но порядок декораторов и `whitelist` ведут себя
 * неочевидно — поэтому повторяем поля явно). Шаги — discriminated union
 * по `type` (re-use `STEP_PAYLOAD_SUBTYPES` из step-payload.dto.ts —
 * один источник истины с CRUD-эндпоинтами).
 *
 * Бизнес-валидация (FEN валиден, PGN парсится chess.js, UCI ходы
 * легальны от FEN) выполняется теми же декораторами, которые подключены
 * в sub-DTO шагов (`@IsFen`, `@IsValidPgn`, `@ArePositionMovesLegal`).
 */

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BLOCK_KEY_REGEX = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const COURSE_LEVELS: ReadonlyArray<CourseLevel> = [
  'beginner',
  'intermediate',
  'advanced',
];

const LESSON_KINDS: ReadonlyArray<LessonKind> = [
  'theory',
  'tactics_set',
  'endgame_set',
  'opening_line',
  'game_review',
  'quiz',
];

/** Метаданные курса (course.yml). */
export class ImportCoursePayloadDto {
  /** Версия формата файла. v1 — текущая. */
  @IsIn([1])
  schemaVersion!: 1;

  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @Matches(SLUG_REGEX, {
    message: 'slug must be kebab-case ([a-z0-9-]+)',
  })
  slug!: string;

  /**
   * KS-2095: язык контента курса. Default 'ru' — сохраняет обратную
   * совместимость с существующими course.yml. Допустимые значения —
   * `'ru' | 'en'`; импортёр может расширить whitelist по мере роста.
   */
  @IsOptional()
  @IsIn(['ru', 'en'])
  lang?: 'ru' | 'en';

  /**
   * KS-2095: slug курса-родителя (root) на другом языке. Используется
   * только при импорте не-RU варианта. Если не задан — импортёр
   * автоматически ищет root по тому же slug на любом другом языке (см.
   * `LessonsAdminImportService.upsertCourse`).
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @Matches(SLUG_REGEX)
  parentSlug?: string;

  @IsString()
  @IsIn([...COURSE_LEVELS])
  level!: CourseLevel;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  descriptionKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  audienceI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  hookI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  outcomeI18nKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  audience?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hook?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  outcome?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  difficulty?: 1 | 2 | 3;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  estimatedMinutes?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  /**
   * KS-2037: упорядоченный список `blockKey`'ев уроков курса. Пишется
   * в `Course.blockOrder`. Если в YAML не задан — поле в БД остаётся
   * пустым массивом (default `[]`). Если задан — все элементы должны
   * быть kebab-case (синоним `Lesson.blockKey`).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(BLOCK_KEY_REGEX, {
    each: true,
    message: 'blockOrder items must be kebab-case ([a-z0-9_-]+)',
  })
  @MaxLength(80, { each: true })
  blockOrder?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

/**
 * Один шаг урока в форме файла: discriminator `type` + поля payload'а
 * inline (без вложенного `payload`-объекта). Это упрощает CLI: то, что
 * автор пишет в YAML, идёт без преобразований.
 */
type ImportStepDto = StepPayloadDto;

/** Метаданные урока (<slug>.lesson.yml). */
export class ImportLessonPayloadDto {
  @IsIn([1])
  schemaVersion!: 1;

  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @Matches(SLUG_REGEX)
  courseSlug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(SLUG_REGEX)
  slug!: string;

  @IsInt()
  @Min(0)
  order!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(BLOCK_KEY_REGEX)
  blockKey!: string;

  @IsString()
  @IsIn([...LESSON_KINDS])
  kind!: LessonKind;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  summaryKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  estMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  /**
   * Шаги — discriminated union по `type`. class-transformer выбирает
   * sub-DTO по совпадению с `STEP_PAYLOAD_SUBTYPES.name`. Минимум 1
   * шаг (как и в `lesson.schema.json` из B-2).
   *
   * KS-2045: верхний лимит снят (раньше 50) — auto-конвертер
   * `pdf-to-lesson-yaml` на больших главах генерирует сотни шагов
   * (ожидается, что Этап 2 ужмёт через PGN→game_review). Зеркалит
   * правку `lesson.schema.json` `steps`.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [...STEP_PAYLOAD_SUBTYPES],
    },
    keepDiscriminatorProperty: true,
  })
  steps!: ImportStepDto[];
}

/** Корневой DTO. */
export class ImportRequestDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ImportCoursePayloadDto)
  course?: ImportCoursePayloadDto;

  @IsObject()
  @ValidateNested()
  @Type(() => ImportLessonPayloadDto)
  lesson!: ImportLessonPayloadDto;

  /** dryRun=true — выполнить весь сценарий, посчитать diff, откатить транзакцию. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

// ─── Response shape ──────────────────────────────────────────────────

export type StepImportAction = 'created' | 'updated' | 'unchanged' | 'removed';

export interface StepImportDiff {
  /** Order шага в новом массиве (для created/updated/unchanged) либо в БД (для removed). */
  order: number;
  type: string;
  action: StepImportAction;
  /** id шага в БД (для updated/unchanged/removed). undefined для created. */
  stepId?: string;
}

export interface ImportResponse {
  ok: true;
  course: { id: string; slug: string; created: boolean; updated: boolean };
  lesson: { id: string; slug: string; created: boolean; updated: boolean };
  diff: {
    added: StepImportDiff[];
    updated: StepImportDiff[];
    removed: StepImportDiff[];
    unchanged: StepImportDiff[];
  };
  /** true если запрос был с dryRun=true (БД не изменилась). */
  dryRun: boolean;
}
