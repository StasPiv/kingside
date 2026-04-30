import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  SyntheticPresenceBatchRequest,
  SyntheticPresenceUpdate,
} from '@kingside/shared';

/**
 * KS-2182. Один элемент batch'а `POST /api/internal/synthetic-presence`.
 * Тип-источник в `@kingside/shared`. class-validator-декораторы добавлены
 * только здесь, runtime-валидация на бэке.
 */
export class SyntheticPresenceUpdateDto implements SyntheticPresenceUpdate {
  @IsString()
  @IsUUID()
  userId!: string;

  @IsString()
  @IsISO8601()
  lastSeenAt!: string;
}

/**
 * KS-2182. Тело batch-запроса. Лимит 200 элементов на запрос —
 * соответствует пулу synthetic'ов (см. `SyntheticConfig.poolSize` и
 * ADR §4.3).
 */
export class SyntheticPresenceBatchDto implements SyntheticPresenceBatchRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SyntheticPresenceUpdateDto)
  updates!: SyntheticPresenceUpdateDto[];
}
