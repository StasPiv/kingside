import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
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

export class SprintStartDto {
  @IsIn([180000, 300000])
  durationMs!: 180000 | 300000;

  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(ALL_TYPES, { each: true })
  types!: TacticDrillType[];
}

export class SprintLeaderboardQueryDto {
  @IsString()
  mode!: string;

  @IsOptional()
  limit?: number;
}
