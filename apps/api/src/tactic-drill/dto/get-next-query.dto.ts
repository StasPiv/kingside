import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { TacticDrillType } from '@kingside/shared';

// KS-2393: исключён `mate-in-1 (deprecated)` (тип удалён).
const ALL_TYPES: TacticDrillType[] = [
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'count-attackers',
  'find-all-checks',
  'find-undefended-attack',
];

export class GetNextQueryDto {
  @IsIn(ALL_TYPES)
  type!: TacticDrillType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  difficulty?: number;
}
