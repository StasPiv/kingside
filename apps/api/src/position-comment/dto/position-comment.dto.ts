import { ArrayMinSize, IsArray, IsString } from 'class-validator';

export class PositionCommentDto {
  @IsString()
  fen!: string;

  /**
   * Любые позиционные факторы — строки или объекты Stockfish-trace
   * ({id, square, color, value_mg, value_eg, ...}). Структура не
   * фиксируется; сервис сериализует массив в JSON и кладёт в сообщение
   * к модели как есть.
   */
  @IsArray()
  @ArrayMinSize(1)
  factors!: unknown[];
}
