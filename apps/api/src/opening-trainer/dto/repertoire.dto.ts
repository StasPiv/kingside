import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';

/**
 * KS-3272 / ADR-077 §3. Request DTO для CRUD репертуаров.
 * Лимиты `OPENING_REPERTOIRE_LIMITS.maxPgnBytes` проверяются на уровне
 * `RepertoireBuilderService.buildTree` — здесь только сырая валидация
 * формата (строка / длина title).
 */

/**
 * KS-3326 / ADR-078 + KS-3475 (ADR-090 §8). Один блок-источник внутри
 * `CreateRepertoireDto.sources` или `CreateRepertoireSourceDto`.
 */
export class RepertoireSourceInputDto {
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /**
   * KS-3475 (ADR-090 §8). Опц., default — `'pgn-upload'`. Для сборки
   * репертуара по позиции из мастер-партий 2400+ — `'archive-position'`.
   */
  @IsOptional()
  @IsIn(['pgn-upload', 'workshop-analysis', 'legacy-import', 'archive-position'])
  sourceKind?:
    | 'pgn-upload'
    | 'workshop-analysis'
    | 'legacy-import'
    | 'archive-position';

  /**
   * KS-3475 (ADR-090 §8). UUID исходной партии из `archive_games`.
   * Опц., имеет смысл только при `sourceKind='archive-position'`.
   */
  @IsOptional()
  @IsUUID()
  archiveGameId?: string;
}

export class CreateRepertoireDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /**
   * @deprecated KS-3324/3326 (ADR-078): используй `sources`. Поле
   * сохранено для backward-compat — backend конвертирует в
   * single-source с `sourceKind='pgn-upload'`. Указывать одновременно
   * с `sources` — 400.
   *
   * Сырой PGN. Размер до 500 КБ — проверяется в builder, тут только
   * грубый upper-bound, чтобы не загружать гигантские строки в память.
   */
  @IsOptional()
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn?: string;

  /**
   * KS-3326 / ADR-078. Массив источников (1..maxSourcesPerRepertoire).
   * Новый формат. Указывать одновременно с `pgn` нельзя (см. service-
   * level валидацию).
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire)
  @ValidateNested({ each: true })
  @Type(() => RepertoireSourceInputDto)
  sources?: RepertoireSourceInputDto[];

  /** KS-3302. Сторона тренировки. Default 'white' если не задано. */
  @IsOptional()
  @IsIn(['white', 'black'])
  side?: 'white' | 'black';
}

/**
 * KS-3326 / ADR-078. Body для `POST /repertoires/:id/sources`.
 * Добавить ещё один источник в существующий репертуар.
 */
export class CreateRepertoireSourceDto {
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(['pgn-upload', 'workshop-analysis', 'legacy-import', 'archive-position'])
  sourceKind?:
    | 'pgn-upload'
    | 'workshop-analysis'
    | 'legacy-import'
    | 'archive-position';

  @IsOptional()
  @IsUUID()
  sourceAnalysisId?: string;

  /**
   * KS-3475 (ADR-090 §8). Для `sourceKind='archive-position'` — UUID
   * исходной партии из `archive_games`.
   */
  @IsOptional()
  @IsUUID()
  archiveGameId?: string;
}

/**
 * KS-3326 / ADR-078. Body для `PATCH /repertoires/:id/sources/:sourceId`.
 */
export class UpdateRepertoireSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn?: string;

  /** `null` чтобы очистить и вернуть fallback. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;
}

export class UpdateRepertoireDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn?: string;

  /** KS-3302. Допустимо менять, но UI обычно не показывает. */
  @IsOptional()
  @IsIn(['white', 'black'])
  side?: 'white' | 'black';
}

export class ListRepertoiresQueryDto {
  @IsOptional()
  @IsString()
  include?: string; // 'stats' для агрегатов
}

export class StartSessionDto {
  /**
   * KS-3302: side игнорируется backend'ом — фактический берётся из
   * `repertoire.side`. Поле опц. оставлено для backward-compat
   * со старыми клиентами.
   */
  @IsOptional()
  @IsIn(['white', 'black'])
  side?: 'white' | 'black';

  @IsIn(['learn', 'review', 'mistakes', 'free'])
  mode!: 'learn' | 'review' | 'mistakes' | 'free';

  @IsOptional()
  @IsIn(['cycle', 'complete'])
  repeatMode?: 'cycle' | 'complete';
}

export class MoveDto {
  /**
   * UCI хода: 'e2e4', 'e7e8q' (promotion). Базовая длина 4–5; полная
   * валидация — на этапе lookup в edges.
   */
  @IsString()
  @MaxLength(8)
  moveUci!: string;

  @IsInt()
  @Min(0)
  responseTimeMs!: number;
}

/**
 * KS-3293 (M2 B7). Body для `POST /opening-trainer/repertoires/from-analysis`.
 *
 * KS-3327 / ADR-078 §4: добавлено опц. `repertoireId` — если задан,
 * PGN анализа добавляется КАК ИСТОЧНИК в существующий репертуар вместо
 * создания нового.
 */
export class CreateRepertoireFromAnalysisDto {
  @IsString()
  @MaxLength(40)
  analysisId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** KS-3302. Сторона тренировки. Default 'white' если не задано. */
  @IsOptional()
  @IsIn(['white', 'black'])
  side?: 'white' | 'black';

  /**
   * KS-3327 / ADR-078. Опц. — UUID существующего репертуара. Если задан,
   * вместо создания нового репертуара добавляем source в этот. Owner-
   * check + лимит maxSourcesPerRepertoire применяются.
   */
  @IsOptional()
  @IsUUID()
  repertoireId?: string;
}
