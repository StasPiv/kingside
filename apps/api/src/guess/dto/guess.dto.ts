/**
 * KS-3409 / ADR-086 §9 B2. DTO запросов guess-the-move с class-validator.
 * Shape совпадает с контрактами из `@kingside/shared` (api-contracts).
 */
import {
  IsString,
  IsInt,
  IsIn,
  IsOptional,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

/** WDL per-mille (0..1000), POV выбранной стороны. */
export class WdlDto {
  @IsNumber() @Min(0) @Max(1000) w!: number;
  @IsNumber() @Min(0) @Max(1000) d!: number;
  @IsNumber() @Min(0) @Max(1000) l!: number;
}

export class StartGuessSessionDto {
  @IsIn(['archive', 'pgn', 'own', 'broadcast'])
  gameSource!: 'archive' | 'pgn' | 'own' | 'broadcast';

  @IsOptional() @IsString()
  gameRef?: string | null;

  @IsOptional() @IsString()
  pgn?: string | null;

  @IsIn(['white', 'black'])
  side!: 'white' | 'black';
}

export class SubmitGuessMoveDto {
  @IsInt() @Min(1)
  ply!: number;

  @IsString() fenBefore!: string;
  @IsString() playedUci!: string;
  @IsString() userUci!: string;
  @IsString() bestUci!: string;

  @IsObject() @ValidateNested() @Type(() => WdlDto)
  wdlBefore!: WdlDto;

  @IsObject() @ValidateNested() @Type(() => WdlDto)
  wdlAfterPlayed!: WdlDto;

  @IsOptional() @ValidateNested() @Type(() => WdlDto)
  wdlAfterUser?: WdlDto | null;
}
