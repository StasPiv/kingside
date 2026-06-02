/**
 * KS-3615 / ADR-102 §3.4 + §4.2. DTO для
 * `POST /api/analysis-review/comments`.
 *
 * Shape — 1:1 с `FactsInput` из `packages/shared/src/types/api-contracts.ts`
 * (тот же контракт фронт собирает в `extractFacts.ts`, KS-3614).
 * Class-validator декораторы — runtime-валидация поверх типа: если фронт
 * пришлёт что-то невалидное, отдаём 400 на уровне ValidationPipe вместо
 * валиться внутри LLM-пайплайна.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const MOVE_CLASS = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
] as const;

const STAGE = ['opening', 'middlegame', 'endgame'] as const;
const SIDE = ['white', 'black'] as const;
const LANG = ['en', 'ru'] as const;
const CASTLING = ['O-O', 'O-O-O'] as const;

class MoveDescriptorDto {
  @IsString()
  san!: string;

  @IsString()
  uci!: string;

  @IsOptional()
  @IsString()
  capture!: string | null;

  @IsBoolean()
  check!: boolean;

  @IsOptional()
  @IsInt()
  mate!: number | null;

  @IsOptional()
  @IsIn(CASTLING as readonly string[])
  castling!: 'O-O' | 'O-O-O' | null;

  @IsOptional()
  @IsString()
  promotion!: string | null;
}

class SfBestDto {
  @IsString()
  uci!: string;

  @IsString()
  san!: string;
}

class MaiaAlternativeDto {
  @IsString()
  uci!: string;

  @IsString()
  san!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  probability!: number;

  @IsIn(MOVE_CLASS as readonly string[])
  classification!: (typeof MOVE_CLASS)[number];
}

class MaterialChangeDto {
  @IsString()
  piece!: string;

  @IsIn(SIDE as readonly string[])
  side!: 'white' | 'black';
}

class HangingPieceDto {
  @IsString()
  square!: string;

  @IsString()
  piece!: string;

  @IsIn(SIDE as readonly string[])
  side!: 'white' | 'black';
}

/**
 * KS-3615 / ADR-102 §3.4. Один факт о ходе.
 * Все optional-поля валидируются как `| null` — фронт всегда присылает
 * ключ (с null) для отсутствующего значения, чтобы порядок был фиксированным.
 */
export class MoveFactsDto {
  @IsInt()
  @Min(0)
  ply!: number;

  @IsString()
  fen!: string;

  @IsIn(SIDE as readonly string[])
  side!: 'white' | 'black';

  @IsObject()
  @ValidateNested()
  @Type(() => MoveDescriptorDto)
  move!: MoveDescriptorDto;

  @IsIn(MOVE_CLASS as readonly string[])
  classification!: (typeof MOVE_CLASS)[number];

  @IsNumber()
  @Min(-1)
  @Max(1)
  delta_e!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => SfBestDto)
  sf_best!: SfBestDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => MaiaAlternativeDto)
  maia_alternative!: MaiaAlternativeDto | null;

  @IsIn(STAGE as readonly string[])
  stage!: 'opening' | 'middlegame' | 'endgame';

  @IsOptional()
  @IsString()
  opening_name!: string | null;

  @IsNumber()
  material_balance!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => MaterialChangeDto)
  material_change!: MaterialChangeDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => HangingPieceDto)
  hanging_piece!: HangingPieceDto | null;

  @IsOptional()
  @IsInt()
  mate_threat_after!: number | null;

  @IsInt()
  @Min(0)
  @Max(3500)
  user_elo!: number;

  @IsIn(LANG as readonly string[])
  user_language!: 'en' | 'ru';
}

/**
 * KS-3615 / ADR-102 §4.2 + §8 B-этап. Body для
 * `POST /api/analysis-review/comments`.
 *
 *  - `facts`: 1..40 элементов. Min — пустой массив не имеет смысла,
 *    Max — защита от перегруза LLM (типичная партия с NAG'ами укладывается
 *    в 15-25 ходов; верхний потолок 40 даёт запас).
 *  - `userElo`: 800..3000 — диапазон калибровки промпта.
 *  - `language`: совпадает с user_language в фактах; явно повторяем на
 *    верхнем уровне для удобства промпт-конструктора.
 */
export class BatchCommentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => MoveFactsDto)
  facts!: MoveFactsDto[];

  @IsInt()
  @Min(800)
  @Max(3000)
  userElo!: number;

  @IsIn(LANG as readonly string[])
  language!: 'en' | 'ru';
}
