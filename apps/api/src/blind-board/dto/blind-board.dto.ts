/**
 * KS-3441 / ADR-088 §11 B2. DTO blind-board с class-validator.
 * KS-3484/3486: добавлен StartBlindBoardSessionBodyDto с опц. config.
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LEVEL_DURATION_PRESETS } from '@kingside/shared';

/** Клетка `[a-h][1-8]`. */
export class SubmitBlindBoardAnswerBodyDto {
  @IsString()
  @Matches(/^[a-h][1-8]$/, { message: 'square must match [a-h][1-8]' })
  square!: string;

  @IsIn(['Q', 'R', 'B', 'N'])
  pieceType!: 'Q' | 'R' | 'B' | 'N';
}

/**
 * KS-3484/3486. Конфиг прогрессивной сложности — приходит опц. в теле
 * POST /blind-board/sessions. Если опущен — backend применяет
 * DEFAULT_BLIND_BOARD_CONFIG. Базовая class-validator валидация (типы,
 * длины); квоты и memorizeTimeSec whitelist проверяет сервис.
 */
export class BlindBoardConfigDto {
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(7)
  @IsIn(['Q', 'R', 'B', 'N'], { each: true })
  startPieces!: Array<'Q' | 'R' | 'B' | 'N'>;

  @IsArray()
  @ArrayMaxSize(7)
  @IsIn(['Q', 'R', 'B', 'N'], { each: true })
  addOrder!: Array<'Q' | 'R' | 'B' | 'N'>;

  @IsInt()
  @IsIn([3, 5, 10])
  memorizeTimeSec!: number;

  /**
   * KS-3550 / ADR-088 V3 §16. Сколько успешных раундов подряд требуется
   * на уровне до перехода на следующий. UI ограничен пресетами
   * `LEVEL_DURATION_PRESETS`; backend whitelist'ит то же самое здесь.
   */
  @IsInt()
  @IsIn([...LEVEL_DURATION_PRESETS])
  levelDurationRounds!: number;

  /**
   * KS-3550 / ADR-088 V3 §16. Глобальный switch прогрессии. `false`
   * выключает level-up'ы независимо от streak.
   */
  @IsBoolean()
  progressionEnabled!: boolean;
}

export class StartBlindBoardSessionBodyDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BlindBoardConfigDto)
  config?: BlindBoardConfigDto;
}
