import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  PuzzleStepPayload,
  PuzzleTheme,
} from '@kingside/shared';
import {
  TextStepPayloadDto,
  EndgameDrillStepPayloadDto,
  PuzzleSelectionIdsDto,
} from '../../dto/step-payload.dto';
import { ALLOWED_USER_STEP_TYPES } from '../user-courses-limits';

/**
 * DTO-валидаторы для `UserLessonStep.payload` (ADR-026 §2.4, KS-1830).
 *
 * Мы не дублируем весь shared-union `StepPayload`. Сценарий «пользователь
 * собирает свой курс» в MVP поддерживает только три типа:
 *   - `text`         — reuse `TextStepPayloadDto` (ADR-024, тот же рендер)
 *   - `puzzle`       — новый `UserPuzzleStepPayloadDto` с `limit: 1..20`
 *     (в системных — до 100; ADR-026 §2.2)
 *   - `endgame_drill`— reuse `EndgameDrillStepPayloadDto`
 *
 * `quiz`, `position`, `game_review`, `video`, `opening_drill` —
 * за пределами whitelist'а. Они явно не объявлены в discriminator'е
 * ниже, и запрос с таким `type` свалится с 400:
 *   `Step type '<type>' not allowed in user courses`.
 *
 * Контроль за расширением: добавляя 4-й тип, нужно:
 *   1. Внести его в `ALLOWED_USER_STEP_TYPES`.
 *   2. Добавить его DTO в `USER_STEP_PAYLOAD_SUBTYPES` ниже.
 *   3. Обновить `UserStepType` в `@kingside/shared`.
 *   4. Обновить UI-select в `StepEditor` (FE-2).
 * Ничего в БД/миграциях менять не надо.
 */

/**
 * Фильтр-вариант `selection` в пользовательском puzzle-шаге. Отличие
 * от системного `PuzzleSelectionFilterDto` — верхняя граница `limit`:
 * 20 у пользователей против 100 у системных (ADR-026 §2.2 — anti-abuse).
 *
 * Extends системного не пользуем сознательно: class-validator берёт
 * декораторы с обоих уровней, и новый `@Max(20)` не «стирает» старый
 * `@Max(100)` — получим два правила с разным смыслом. Проще
 * переопределить весь класс.
 */
class UserPuzzleSelectionFilterDto {
  @IsIn(['filter'])
  mode!: 'filter';

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  themes!: PuzzleTheme[];

  @IsOptional()
  @IsInt()
  @Min(0)
  ratingMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  ratingMax?: number;

  @IsInt()
  @Min(1)
  @Max(20)
  limit!: number;
}

export class UserPuzzleStepPayloadDto implements PuzzleStepPayload {
  @IsIn(['puzzle'])
  type!: 'puzzle';

  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'mode',
      subTypes: [
        { value: PuzzleSelectionIdsDto, name: 'ids' },
        { value: UserPuzzleSelectionFilterDto, name: 'filter' },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  selection!: PuzzleSelectionIdsDto | UserPuzzleSelectionFilterDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSolved?: number;
}

// Реэкспорт системных DTO, которые используем как есть — чтобы импорты
// в Create/Update DTO собирались из одного места.
export { TextStepPayloadDto, EndgameDrillStepPayloadDto };

/**
 * Whitelist discriminator subtypes для `@Type` на `payload` в
 * `CreateUserLessonStepDto` и `UpdateUserLessonStepDto`.
 */
export const USER_STEP_PAYLOAD_SUBTYPES = [
  { value: TextStepPayloadDto, name: 'text' },
  { value: UserPuzzleStepPayloadDto, name: 'puzzle' },
  { value: EndgameDrillStepPayloadDto, name: 'endgame_drill' },
] as const;

export type UserStepPayloadDto =
  | TextStepPayloadDto
  | UserPuzzleStepPayloadDto
  | EndgameDrillStepPayloadDto;

/**
 * Проверка type на whitelist до того, как class-transformer попробует
 * инстанцировать subtype (иначе при `type='video'` он вернёт raw object
 * без валидации — «тихо пропустит»). Используется в сервисе как
 * дополнительный guard и в `ValidateUserStepType` декораторе ниже.
 */
export function assertAllowedUserStepType(type: unknown): void {
  if (typeof type !== 'string' || !ALLOWED_USER_STEP_TYPES.includes(type as any)) {
    // Bad Request выкидывает сервис — чтобы не тянуть NestJS сюда,
    // возвращаем обычный Error с ясным сообщением; вызывающий код
    // оборачивает в BadRequestException.
    throw new Error(
      `Step type '${String(type)}' not allowed in user courses. Allowed: ${ALLOWED_USER_STEP_TYPES.join(', ')}`,
    );
  }
}
