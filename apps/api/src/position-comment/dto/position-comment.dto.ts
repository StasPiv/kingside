import {
  IsArray,
  IsIn,
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

/** ADR-108 §8.2. Язык ответа модели. */
const POSITION_COMMENT_LANG = ['ru', 'en'] as const;
export type PositionCommentLanguage = (typeof POSITION_COMMENT_LANG)[number];

export class PositionCommentDto {
  @IsString()
  fen!: string;

  /**
   * Позиционные факторы — массив подкомпонент Stockfish-trace из
   * вывода `eval json` (поле `subterms`) либо строки/любые объекты.
   * Структура каждого элемента не фиксируется; сервис сериализует
   * массив в JSON как есть.
   *
   * KS-3681 / ADR-108 §11 B1: `@ArrayMinSize(1)` снят. Пустой массив —
   * валиден; сервис при пустых факторах сразу возвращает `""` без
   * обращения к webhook'у (экономия квоты).
   */
  @IsArray()
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

  /**
   * KS-3681 / ADR-108 §8. Язык ответа модели. По умолчанию `'ru'`.
   * Frontend подставляет значение из `i18n.language`. Старые клиенты
   * без поля продолжают получать русский комментарий — backward-compat.
   */
  @IsOptional()
  @IsIn(POSITION_COMMENT_LANG as readonly string[])
  language?: PositionCommentLanguage;
}
