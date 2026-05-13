import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  STUDY_LIMITS,
  STUDY_CHAPTER_ORIENTATIONS,
  STUDY_CHAPTER_MODES,
  STUDY_VISIBILITIES,
  STUDY_TOPIC_MAX,
  STUDY_TOPIC_LENGTH_MAX,
} from '../study-limits';

/**
 * KS-2815 / KS-2818 T3. DTO для CRUD-эндпоинтов Studies (T4) и
 * StudyPublicController (T6). Размещены в `dto/` рядом с сервисами,
 * чтобы их можно было импортировать без подтягивания всего модуля.
 */

export class CreateStudyDto {
  @IsString()
  @MaxLength(STUDY_LIMITS.studyNameMaxLength)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.studyDescriptionMaxLength)
  description?: string;

  /**
   * DEPRECATED KS-2856 / ADR-060 §3.2. Используй `visibility` — но
   * на время раскатки Phase 2 поле принимается и маппится в
   * `visibility` (true → 'public', false → 'private') в сервисе (B3).
   */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /**
   * KS-2856 / ADR-060 §3.2. Видимость студии: 'private' (default) |
   * 'unlisted' | 'public'. Приоритет над `isPublic` если оба заданы.
   */
  @IsOptional()
  @IsIn(STUDY_VISIBILITIES as readonly string[])
  visibility?: (typeof STUDY_VISIBILITIES)[number];

  /**
   * KS-2856 / ADR-060 §3.4. Темы — лимит 5 элементов, lower-case,
   * ≤30 символов каждый. Нормализация (toLowerCase + trim) делается
   * сервисом перед записью; здесь только формальные ограничения.
   */
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(STUDY_TOPIC_MAX)
  @MaxLength(STUDY_TOPIC_LENGTH_MAX, { each: true })
  topics?: string[];
}

export class UpdateStudyDto {
  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.studyNameMaxLength)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.studyDescriptionMaxLength)
  description?: string;

  /** DEPRECATED: см. CreateStudyDto.isPublic. */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsIn(STUDY_VISIBILITIES as readonly string[])
  visibility?: (typeof STUDY_VISIBILITIES)[number];

  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(STUDY_TOPIC_MAX)
  @MaxLength(STUDY_TOPIC_LENGTH_MAX, { each: true })
  topics?: string[];
}

/** KS-2818 T3. Listing query: `?mine=1` мои, `?mine=0` публичные. */
export class ListStudiesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mine?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class CreateChapterDto {
  @IsString()
  @MaxLength(STUDY_LIMITS.chapterNameMaxLength)
  name!: string;

  /**
   * Тело PGN главы. Может быть пустой строкой (свежая глава без
   * ходов). Проверка размера в `chapterPgnMaxBytes` делается в
   * сервисе через `Buffer.byteLength` — `MaxLength` тут на символах,
   * с верхней границей чуть больше байтового лимита для UTF-8.
   */
  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.chapterPgnMaxBytes)
  pgn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.startFenMaxLength)
  startFen?: string;

  @IsOptional()
  @IsIn(STUDY_CHAPTER_ORIENTATIONS as readonly string[])
  orientation?: (typeof STUDY_CHAPTER_ORIENTATIONS)[number];

  @IsOptional()
  @IsIn(STUDY_CHAPTER_MODES as readonly string[])
  mode?: (typeof STUDY_CHAPTER_MODES)[number];

  /** KS-2856 / ADR-060 §3.3 R3. Для mode='conceal'. */
  @IsOptional()
  @IsInt()
  @Min(0)
  concealPly?: number;

  /**
   * KS-2856 / ADR-060 §3.3 R4. Для mode='gamebook'. Структура
   * валидируется отдельно `validateGamebookPayload` в сервисе
   * (B3) — class-validator не покрывает Record-ключи.
   */
  @IsOptional()
  @IsObject()
  gamebook?: Record<string, unknown>;
}

export class UpdateChapterDto {
  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.chapterNameMaxLength)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.chapterPgnMaxBytes)
  pgn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.startFenMaxLength)
  startFen?: string | null;

  @IsOptional()
  @IsIn(STUDY_CHAPTER_ORIENTATIONS as readonly string[])
  orientation?: (typeof STUDY_CHAPTER_ORIENTATIONS)[number];

  @IsOptional()
  @IsIn(STUDY_CHAPTER_MODES as readonly string[])
  mode?: (typeof STUDY_CHAPTER_MODES)[number];

  /** KS-2856 / ADR-060 §3.3 R3. Для mode='conceal'. */
  @IsOptional()
  @IsInt()
  @Min(0)
  concealPly?: number | null;

  /**
   * KS-2856 / ADR-060 §3.3 R4. Для mode='gamebook'. См. CreateChapterDto.
   * Передача `null` явно сбрасывает payload.
   */
  @IsOptional()
  @IsObject()
  gamebook?: Record<string, unknown> | null;
}

/**
 * KS-2856 / ADR-060 §3.3 R4 (KS-2858 B2). Специализированный PATCH
 * для gamebook payload'а — отдельный эндпоинт (B5) чтобы фронт мог
 * слать только payload без всего ChapterDto.
 */
export class UpdateGamebookDto {
  @IsObject()
  gamebook!: Record<string, unknown>;
}

/**
 * KS-2856 / ADR-060 §3.2. Inviting contributor (B5):
 * `POST /studies/:slug/members` body `{ userIdOrUsername }`.
 */
export class InviteMemberDto {
  @IsString()
  userIdOrUsername!: string;
}

/**
 * Переупорядочивание главы. `after = null` — поставить в начало;
 * `after = "<chapterId>"` — после указанной главы. Конечная позиция
 * пересчитывается сервисом в значение `orderIdx`.
 */
export class ReorderChapterDto {
  @IsOptional()
  @IsString()
  after?: string | null;
}

/** Импорт multi-PGN: одно поле `pgn` (sourcing) — splitPgn разбивает. */
export class ImportPgnDto {
  @IsString()
  pgn!: string;
}

/**
 * KS-2882 / ADR-060 §3.6. Save-to-study из AnalysisPage.
 *
 * XOR: либо `studyId` (добавить главу в существующую студию), либо
 * `newStudyName` (создать новую private-студию и положить главу туда).
 * Оба или ни одного → 400, проверяется в сервисе.
 */
export class StudyFromAnalysisDto {
  @IsUUID()
  analysisId!: string;

  @IsOptional()
  @IsUUID()
  studyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_LIMITS.studyNameMaxLength)
  newStudyName?: string;
}

/**
 * KS-2880 / ADR-060 §3.4. Каталог публичных студий.
 *
 * `GET /api/studies/catalog?sort=hot|new|updated|popular&q=&topic=&page=&pageSize=`.
 *
 * - sort default = 'hot'.
 * - page default = 1, min = 1.
 * - pageSize default = 20, max = 50, min = 1.
 * - q (опционально) — ILIKE по `name`+`description` без full-text.
 * - topic (опционально) — точное совпадение элемента в `topics` (PG `@>`).
 *
 * Каталог содержит ТОЛЬКО `visibility='public'`; `unlisted`/`private`
 * не попадают (см. ADR-060 §2.6).
 */
export const STUDY_CATALOG_SORTS = ['hot', 'new', 'updated', 'popular'] as const;
export type StudyCatalogSort = (typeof STUDY_CATALOG_SORTS)[number];

/**
 * KS-2881 / ADR-060 §2.8 K6. Query для `GET /studies/by/:userId`.
 *
 *  - page default 1, pageSize default 20 max 50;
 *  - `includePrivate=1` имеет смысл только когда caller == :userId; для
 *    остальных параметр игнорируется (сервис сам режет).
 */
export class StudyByUserQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  /**
   * `1`/`true` — auth-self хочет видеть и свои `unlisted`/`private` тоже.
   * Для caller != :userId — параметр игнорируется (отдаём только public).
   */
  @IsOptional()
  @IsString()
  includePrivate?: string;
}

export class StudyCatalogQueryDto {
  @IsOptional()
  @IsIn(STUDY_CATALOG_SORTS as readonly string[])
  sort?: StudyCatalogSort;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STUDY_TOPIC_LENGTH_MAX)
  topic?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
