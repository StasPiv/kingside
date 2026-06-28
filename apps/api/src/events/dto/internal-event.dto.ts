/**
 * KS-4748 / ADR-149 G2. DTO для `POST /internal/events`. Соответствует
 * `InternalEventInput` из `@kingside/events-client`, плюс class-validator
 * декораторы для ValidationPipe.
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class InternalEventActorDto {
  @IsIn(['user', 'guest'])
  type!: 'user' | 'guest';

  @IsString()
  @MinLength(1)
  id!: string;
}

export class InternalEventInputDto {
  @ValidateNested()
  @Type(() => InternalEventActorDto)
  actor!: InternalEventActorDto;

  /** 1..64, как `@db.VarChar(64)` в schema.prisma. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  type!: string;

  /** Произвольный JSON-объект; внутренняя структура не валидируется. */
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown> | null;

  /** ISO-8601 время эмита на стороне источника. Если нет — now() на приёме. */
  @IsOptional()
  @IsISO8601()
  ts?: string;
}
