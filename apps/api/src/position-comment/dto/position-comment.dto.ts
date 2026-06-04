import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Финальная оценка статической позиции — поле `total` из вывода нашей
 * версии Stockfish-trace (`eval json`). mg/eg/v — middlegame / endgame /
 * final, в сантипешках с точки зрения стороны, чей ход (для `v`).
 */
export class PositionEvalDto {
  @IsNumber()
  mg!: number;

  @IsNumber()
  eg!: number;

  @IsNumber()
  v!: number;
}

export class PositionCommentDto {
  @IsString()
  fen!: string;

  /**
   * Позиционные факторы — массив подкомпонент Stockfish-trace из
   * вывода `eval json` (поле `subterms`) либо строки/любые объекты.
   * Структура каждого элемента не фиксируется; сервис сериализует
   * массив в JSON как есть.
   */
  @IsArray()
  @ArrayMinSize(1)
  factors!: unknown[];

  /**
   * Опциональная финальная оценка позиции из того же вывода
   * `eval json` (поле `total`). Если фронт передаёт — кладётся в
   * сообщение к модели вместе с факторами, чтобы комментарий
   * учитывал общий перевес.
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PositionEvalDto)
  eval?: PositionEvalDto;
}
