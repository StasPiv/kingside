import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import type { LessonStepType } from '@kingside/shared';
import {
  STEP_PAYLOAD_SUBTYPES,
  type StepPayloadDto,
} from '../../dto/step-payload.dto';

/**
 * KS-1962/B-7 — DTO для admin-CRUD шагов
 * (`/lessons/admin/lessons/:lessonId/steps`,
 * `/lessons/admin/steps/:id`).
 *
 * payload — дискриминированный union по полю `type` (см.
 * `STEP_PAYLOAD_SUBTYPES`); class-validator выбирает sub-DTO по
 * совпадению `type`-значения. Контракт §3.4: если в PATCH меняется
 * `type`, `payload` ОБЯЗАТЕЛЕН — иначе старая форма payload не
 * совместима с новым типом. Эта проверка делается на стороне сервиса
 * (одним декоратором её аккуратно не выразить).
 */

const LESSON_STEP_TYPES: ReadonlyArray<LessonStepType> = [
  'text',
  'puzzle',
  'quiz',
  'position',
  'game_review',
  'video',
  'endgame_drill',
  'opening_drill',
  // KS-2249: тактический drill (8 типов из methodology §2) в составе урока.
  'drill',
];

export class CreateAdminStepDto {
  @IsIn([...LESSON_STEP_TYPES])
  type!: LessonStepType;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  /**
   * Дискриминированный union по `type`. class-transformer выберет
   * нужный sub-DTO по `STEP_PAYLOAD_SUBTYPES` и натравит его
   * валидаторы. `keepDiscriminatorProperty` сохраняет `type` в
   * объекте — он совпадает с `CreateAdminStepDto.type` (контроль —
   * на сервисе, см. `LessonsAdminService.createStep`).
   */
  @IsObject()
  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [...STEP_PAYLOAD_SUBTYPES],
    },
    keepDiscriminatorProperty: true,
  })
  payload!: StepPayloadDto;
}

export class UpdateAdminStepDto {
  @IsOptional()
  @IsIn([...LESSON_STEP_TYPES])
  type?: LessonStepType;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  /**
   * Опционально, но при смене `type` обязателен (см. концепт §3.4).
   * Сервис кидает 400, если type меняется без payload.
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'type',
      subTypes: [...STEP_PAYLOAD_SUBTYPES],
    },
    keepDiscriminatorProperty: true,
  })
  payload?: StepPayloadDto;
}

/**
 * Полный список id шагов урока в новом порядке. См. §3.5: ids
 * должен покрывать ВСЕ шаги урока, иначе 400.
 *
 * KS-2045: верхний лимит на размер массива снят (раньше 1000) —
 * зеркалит снятие лимита в `lesson.schema.json` / `ImportLessonPayloadDto.steps`.
 */
export class ReorderAdminStepsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids!: string[];
}
