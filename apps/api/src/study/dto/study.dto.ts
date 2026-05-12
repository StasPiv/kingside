import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  STUDY_LIMITS,
  STUDY_CHAPTER_ORIENTATIONS,
  STUDY_CHAPTER_MODES,
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

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
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

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
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
