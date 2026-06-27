/**
 * KS-4674 / ADR-146 §3 п.4. Request DTO админских CRUD-операций над
 * демо-репертуарами `is_demo=true`. Отделены от
 * пользовательских (`CreateRepertoireDto` в `../dto/repertoire.dto.ts`)
 * — у админских свой набор обязательных полей (`slug`, `isPublished`,
 * inline `pgn`), не дублирующий sources-API ADR-078.
 */
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';

/**
 * `slug` валидируется как `[a-z0-9-]+` 1..80 символов — те же ограничения,
 * что были у file-seed (`DemoRepertoireSeedService.SLUG_RE`) и
 * `BlogMediaService.sanitizeSlug`.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateAdminRepertoireDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(SLUG_RE, {
    message: 'slug must match [a-z0-9]+(?:-[a-z0-9]+)* (1..80 chars)',
  })
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(['white', 'black'])
  side!: 'white' | 'black';

  /** Cырой PGN — единственный источник дерева для админского демо. */
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn!: string;

  /**
   * Default `false` (черновик). Публичный `/opening-trainer/demo`
   * показывает только `is_demo=true AND is_published=true`.
   */
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateAdminRepertoireDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(SLUG_RE, {
    message: 'slug must match [a-z0-9]+(?:-[a-z0-9]+)* (1..80 chars)',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(['white', 'black'])
  side?: 'white' | 'black';

  /** Если задан — дерево пересобирается из этого нового PGN. */
  @IsOptional()
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn?: string;
}

export class UpdateAdminRepertoireStatusDto {
  @IsBoolean()
  isPublished!: boolean;
}
