/**
 * KS-4803. DTO `GET /admin/hints-diagnose`. Симметричен
 * `AdminListEventsQueryDto` (KS-4801): `actorId` обязательный UUID,
 * `actorType` опционально (default `'user'`), плюс опциональный
 * `hintId` для сужения до одного hint.
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export type DiagnoseActorType = 'user' | 'guest';

export class HintsDiagnoseQueryDto {
  /** UUID actor'а (users.id или guest-uuid). */
  @IsString()
  @IsUUID('4')
  actorId!: string;

  /** Тип actor'а. По умолчанию — `'user'`. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    return String(value).toLowerCase();
  })
  @IsIn(['user', 'guest'])
  actorType?: DiagnoseActorType;

  /**
   * Опционально: сузить выборку `actor_hint_states` до одного hint.
   * Если не задан — возвращаем все state'ы actor'а.
   */
  @IsOptional()
  @IsString()
  @IsUUID('4')
  hintId?: string;
}
