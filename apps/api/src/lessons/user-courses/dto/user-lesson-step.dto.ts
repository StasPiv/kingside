import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  CreateUserLessonStepRequest,
  ReorderUserStepsRequest,
  UpdateUserLessonStepRequest,
  UserStepType,
} from '@kingside/shared';
import {
  ALLOWED_USER_STEP_TYPES,
  AllowedUserStepType,
} from '../user-courses-limits';
import {
  USER_STEP_PAYLOAD_SUBTYPES,
  UserStepPayloadDto,
} from './user-step-payload.dto';

/**
 * DTO для `POST /lessons/user-lessons/:id/steps` (ADR-026 §2.4, KS-1830).
 *
 * Discriminator: `@Type` инстанцирует `payload` по полю `payload.type`
 * ТОЛЬКО если `type` ∈ whitelist (см. `USER_STEP_PAYLOAD_SUBTYPES`).
 * Поле `type` на верхнем уровне обязано совпадать с `payload.type` —
 * это договор в ADR-024, его проверим в сервисе отдельной строкой.
 *
 * Если `type` НЕ в whitelist — class-validator `@IsIn` кидает 400, что
 * соответствует DoD «video/quiz/game_review/opening_drill → 400».
 */
export class CreateUserLessonStepDto implements CreateUserLessonStepRequest {
  /**
   * `@IsIn([...ALLOWED_USER_STEP_TYPES])` — единственный способ отсечь
   * не-whitelist значение сообщением «must be one of the following»,
   * ValidationPipe развернёт его в 400 с понятным телом.
   */
  @IsIn(ALLOWED_USER_STEP_TYPES as unknown as string[], {
    message: `type must be one of: ${ALLOWED_USER_STEP_TYPES.join(', ')} (others not allowed in user courses)`,
  })
  type!: AllowedUserStepType & UserStepType;

  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [...USER_STEP_PAYLOAD_SUBTYPES],
    },
    keepDiscriminatorProperty: true,
  })
  payload!: UserStepPayloadDto;
}

/**
 * PATCH /lessons/user-lesson-steps/:id — можно менять `payload`
 * (сохранит тот же `type`, т.к. БД уже хранит его) и/или `order`.
 * Менять тип шага через PATCH не поддерживаем: если автор хочет
 * сменить тип — удалить и создать заново (проще модель, чем миграция
 * payload'а между несовместимыми shape'ами).
 */
export class UpdateUserLessonStepDto implements UpdateUserLessonStepRequest {
  @IsOptional()
  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [...USER_STEP_PAYLOAD_SUBTYPES],
    },
    keepDiscriminatorProperty: true,
  })
  payload?: UserStepPayloadDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

/**
 * POST /lessons/user-lessons/:id/steps/reorder — массовый order-апдейт.
 * Валидация «id принадлежат уроку» — уже в сервисе, на DTO только
 * базовые проверки.
 */
export class ReorderUserStepsDto implements ReorderUserStepsRequest {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}
