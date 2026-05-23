import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';

/**
 * KS-3272 / ADR-077 §3. Request DTO для CRUD репертуаров.
 * Лимиты `OPENING_REPERTOIRE_LIMITS.maxPgnBytes` проверяются на уровне
 * `RepertoireBuilderService.buildTree` — здесь только сырая валидация
 * формата (строка / длина title).
 */

export class CreateRepertoireDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /**
   * Сырой PGN. Размер до 500 КБ — проверяется в builder, тут только
   * грубый upper-bound, чтобы не загружать гигантские строки в память.
   */
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn!: string;
}

export class UpdateRepertoireDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(OPENING_REPERTOIRE_LIMITS.maxPgnBytes * 2)
  pgn?: string;
}

export class ListRepertoiresQueryDto {
  @IsOptional()
  @IsString()
  include?: string; // 'stats' для агрегатов
}

export class StartSessionDto {
  @IsIn(['white', 'black'])
  side!: 'white' | 'black';

  @IsIn(['learn', 'review', 'mistakes', 'free'])
  mode!: 'learn' | 'review' | 'mistakes' | 'free';

  @IsOptional()
  @IsIn(['cycle', 'complete'])
  repeatMode?: 'cycle' | 'complete';
}

export class MoveDto {
  /**
   * UCI хода: 'e2e4', 'e7e8q' (promotion). Базовая длина 4–5; полная
   * валидация — на этапе lookup в edges.
   */
  @IsString()
  @MaxLength(8)
  moveUci!: string;

  @IsInt()
  @Min(0)
  responseTimeMs!: number;
}
