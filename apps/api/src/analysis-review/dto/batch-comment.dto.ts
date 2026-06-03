/**
 * KS-3615 / ADR-102 §3.4 (MVP-1) + KS-3625 / ADR-103 rev 2 §5 (MVP-2).
 * DTO для `POST /api/analyses/review/comments`.
 *
 * Shape — 1:1 с `FactsInput` из `packages/shared/src/types/api-contracts.ts`
 * (тот же контракт фронт собирает в `extractFacts.ts`, KS-3623).
 * Class-validator декораторы — runtime-валидация поверх типа: если фронт
 * пришлёт что-то невалидное, отдаём 400 на уровне ValidationPipe вместо
 * валиться внутри LLM-пайплайна.
 *
 * MVP-2 расширение: `fen_after`, расширенный `hanging_piece`,
 * `sf_best.line`, `tactical_motifs[]`, `threats_created`,
 * `threats_missed`, `positional_shifts[]` (фронт всегда `[]`, бэк
 * мутирует через `StockfishEvalService` перед prompt-builder'ом).
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

const TACTICAL_MOTIFS = [
  'fork',
  'double_attack',
  'pin',
  'skewer',
  'discovered_attack',
  'back_rank_weak',
] as const;

const ANY_PIECE = ['p', 'n', 'b', 'r', 'q', 'k'] as const;
const NON_KING_PIECE = ['p', 'n', 'b', 'r', 'q'] as const;

/**
 * 19 ярлыков (ADR-103 §6.5). Используется в @IsIn — оставляем строкой
 * на уровне фронта (приходит `[]`), но если фронт почему-то прислал
 * заполненный массив, валидация не пустит чужие значения.
 */
const POSITIONAL_SHIFT_IDS = [
  'material_gained',
  'material_lost',
  'pawn_structure_improved',
  'pawn_structure_weakened',
  'knight_more_active',
  'bishop_more_active',
  'bishop_passive',
  'rook_on_open_file',
  'queen_more_active',
  'mobility_increased',
  'mobility_decreased',
  'king_safer',
  'king_exposed',
  'threats_grew',
  'threats_weakened',
  'passed_pawn_strong',
  'space_gained',
  'position_more_winnable',
  'position_less_winnable',
] as const;

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

  /**
   * MVP-2 (ADR-103 §5): 2–3 хода SAN продолжения из `sfBestPv`. Может
   * быть пустым массивом (фронт не получил PV).
   */
  @IsArray()
  @IsString({ each: true })
  line!: string[];
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

class ExchangeParticipantDto {
  @IsIn(ANY_PIECE as readonly string[])
  piece!: (typeof ANY_PIECE)[number];

  @IsString()
  square!: string;
}

class HangingPieceDto {
  @IsString()
  square!: string;

  @IsIn(NON_KING_PIECE as readonly string[])
  piece!: (typeof NON_KING_PIECE)[number];

  @IsIn(SIDE as readonly string[])
  side!: 'white' | 'black';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExchangeParticipantDto)
  attackers!: ExchangeParticipantDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExchangeParticipantDto)
  defenders!: ExchangeParticipantDto[];

  @IsNumber()
  net_material_if_taken!: number;
}

class ThreatTargetDto {
  @IsIn(ANY_PIECE as readonly string[])
  piece!: (typeof ANY_PIECE)[number];

  @IsString()
  square!: string;
}

class WinsMaterialThreatDto {
  @IsIn(ANY_PIECE as readonly string[])
  piece!: (typeof ANY_PIECE)[number];

  @IsString()
  square!: string;

  @IsNumber()
  net_value!: number;
}

class ThreatsCreatedDto {
  @IsOptional()
  @IsInt()
  mate_in?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => WinsMaterialThreatDto)
  wins_material?: WinsMaterialThreatDto;

  @IsOptional()
  @IsBoolean()
  double_attack?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ThreatTargetDto)
  targets?: ThreatTargetDto[];
}

class ThreatsMissedDto {
  @IsOptional()
  @IsInt()
  mate_in?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => WinsMaterialThreatDto)
  wins_material?: WinsMaterialThreatDto;

  @IsOptional()
  @IsString()
  counter_threat?: string;
}

/**
 * KS-3615 / ADR-102 §3.4 + KS-3625 / ADR-103 §5. Один факт о ходе.
 * Все optional-поля валидируются как `| null` — фронт всегда присылает
 * ключ (с null) для отсутствующего значения, чтобы порядок был фиксированным.
 */
export class MoveFactsDto {
  @IsInt()
  @Min(0)
  ply!: number;

  @IsString()
  fen!: string;

  /** ADR-103 §5 — FEN ПОСЛЕ played-хода (для SF eval на бэке). */
  @IsString()
  fen_after!: string;

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

  /** ADR-103 §5 — тактические мотивы (0..6 значений). */
  @IsArray()
  @IsIn(TACTICAL_MOTIFS as readonly string[], { each: true })
  tactical_motifs!: (typeof TACTICAL_MOTIFS)[number][];

  /** ADR-103 §5 — что создаёт played-ход. `{}` валиден. */
  @IsObject()
  @ValidateNested()
  @Type(() => ThreatsCreatedDto)
  threats_created!: ThreatsCreatedDto;

  /** ADR-103 §5 — что упустил слабый ход относительно `sf_best`. */
  @IsObject()
  @ValidateNested()
  @Type(() => ThreatsMissedDto)
  threats_missed!: ThreatsMissedDto;

  /**
   * ADR-103 §6.5 — позиционные ярлыки. Фронт всегда шлёт `[]`; бэк
   * мутирует через `StockfishEvalService` перед prompt-builder'ом.
   * Валидация значений на случай если фронт по ошибке прислал union.
   */
  @IsArray()
  @IsIn(POSITIONAL_SHIFT_IDS as readonly string[], { each: true })
  positional_shifts!: (typeof POSITIONAL_SHIFT_IDS)[number][];

  @IsInt()
  @Min(0)
  @Max(3500)
  user_elo!: number;

  @IsIn(LANG as readonly string[])
  user_language!: 'en' | 'ru';
}

/**
 * KS-3615 / ADR-102 §4.2 + §8 B-этап. Body для
 * `POST /api/analyses/review/comments`.
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
