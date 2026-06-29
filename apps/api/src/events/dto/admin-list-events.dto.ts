/**
 * KS-4801. DTO `GET /admin/events?actorId=&actorType=&cursor=&limit=&types=&showSystem=`.
 *
 * Симметричен `ListEventsQueryDto` (`/me/events`), но:
 *   - `actorId` обязательный — service-account явно указывает кого
 *     смотрит (для `/me` он зашит в `req.user.id`);
 *   - `actorType` опциональный, default `'user'`. `'guest'` нужен для
 *     диагностики гостевых сессий (тот же `events.actor_events`).
 *
 * Остальные поля наследуются.
 */
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ListEventsQueryDto } from '../../me/dto/list-events.dto';

export type AdminActorType = 'user' | 'guest';

export class AdminListEventsQueryDto extends ListEventsQueryDto {
  /** Кого смотрим. UUID `users.id` (для actorType=user) либо guest-uuid. */
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
  actorType?: AdminActorType;
}
