import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { TacticDrillType } from '@kingside/shared';
import { AnswerDataDto } from './answer.dto';

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

export class SprintStartDto {
  @IsIn([180000, 300000])
  durationMs!: 180000 | 300000;

  @IsArray()
  @ArrayMaxSize(7)
  @IsIn(ALL_TYPES, { each: true })
  types!: TacticDrillType[];

  /** Принудительно перезапустить активную сессию (см. api-contract §5.4). */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class SprintSubmitDto {
  @IsUUID()
  sessionId!: string;

  @IsUUID()
  drillId!: string;

  @ValidateNested()
  @Type(() => AnswerDataDto)
  userAnswer!: AnswerDataDto;

  @IsInt()
  @Min(0)
  timeMs!: number;
}

export class SprintFinishDto {
  @IsUUID()
  sessionId!: string;
}

export class SprintLeaderboardQueryDto {
  @IsString()
  mode!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
