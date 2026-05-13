import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * KS-2967 / ADR-063 §6.4 — query параметры для `GET /knowledge/read`.
 *
 * Cap на диапазон строк (`endLine - startLine + 1 ≤ 500`) проверяется
 * в сервисе после нормализации значений, а не декоратором — чтобы
 * пользователь мог передать только `startLine` без `endLine` и получить
 * дефолтный диапазон.
 */
export class KnowledgeReadDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  path!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  startLine?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  endLine?: number;
}
