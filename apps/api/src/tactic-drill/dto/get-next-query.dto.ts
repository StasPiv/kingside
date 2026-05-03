import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { TacticDrillType } from '@kingside/shared';

const ALL_TYPES: TacticDrillType[] = [
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
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
