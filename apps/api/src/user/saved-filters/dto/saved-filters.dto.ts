import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import type { SavedFilterSection } from '@kingside/shared';

/**
 * KS-2924 / KS-2927 Phase A3. DTO-слой `/api/user/saved-filters`.
 *
 * Дискриминатор `section` валидируется на верхнем уровне через
 * `@IsIn(['workshop','archive'])`. Тело `params` валидируется в
 * сервисе через {@link normalizeSavedFilterParams} (ручной
 * type-guard + санитизация неизвестных полей). Причина:
 *   1) глобальный `ValidationPipe` собран без `transform: true`,
 *      поэтому декоратор `@Type` с `discriminator` не работает;
 *   2) ручной нормализатор корректно отбрасывает unknown-поля и
 *      гарантирует, что в JSONB ложится канонический объект,
 *      соответствующий `SavedFilterParams` из @kingside/shared.
 */
export class SavedFiltersListQueryDto {
  @IsIn(['workshop', 'archive'])
  section!: SavedFilterSection;
}

export class CreateSavedFilterDto {
  @IsIn(['workshop', 'archive'])
  section!: SavedFilterSection;

  /** Имя фильтра. 1..100 символов, сервис делает дополнительный
   *  trim — поэтому строки из одних пробелов отклоняются как пустые. */
  @IsString()
  @Length(1, 100)
  name!: string;

  /** Сырое тело параметров. Нормализуется в сервисе. */
  @IsObject()
  params!: unknown;
}

export class UpdateSavedFilterDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  /** Менять `section` существующего фильтра нельзя — для смены
   *  секции пользователь создаёт новый фильтр и удаляет старый. */
  @IsOptional()
  @IsObject()
  params?: unknown;
}
