import {
  IsArray,
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

/**
 * KS-4049. Значение одного агрегированного блока метрик: значение в
 * пешках после фазовой свёртки `(mg·phase + eg·(256−phase))/256`.
 * Имя поля `value_cp` сохранено как у фронта (исторически — «вклад в
 * cp-выражении»), но фактическое число подаётся в пешках с возможной
 * дробью (например 1.3).
 */
export class MetricsBlockValueDto {
  @IsNumber()
  value_cp!: number;
}

/**
 * KS-4049. Сгруппированные агрегаты по 7 блокам, собранные фронтом из
 * `PositionalSubterm` (см. KS-4043). Опциональное расширение DTO —
 * приходит дополнительно к сырому `factors[]`. Модель видит оба
 * источника, взвешивает сама; backend сериализует обе части в
 * пользовательское сообщение.
 */
export class MetricsAggregatesDto {
  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  material!: MetricsBlockValueDto;

  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  pawn_structure!: MetricsBlockValueDto;

  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  king_safety!: MetricsBlockValueDto;

  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  pieces!: MetricsBlockValueDto;

  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  mobility!: MetricsBlockValueDto;

  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  threats!: MetricsBlockValueDto;

  @ValidateNested()
  @Type(() => MetricsBlockValueDto)
  passed_pawns!: MetricsBlockValueDto;
}

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

  /**
   * KS-4049. Сгруппированные агрегаты по 7 блокам метрик из KS-4043.
   * Опциональны: фронт шлёт только если массив `factors` непустой
   * (есть PositionalTrace). Старые клиенты без поля продолжают
   * получать комментарий по сырой трассе — backward-compat.
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MetricsAggregatesDto)
  metrics?: MetricsAggregatesDto;

  /**
   * KS-4049. Фаза позиции 0..256 из `PositionalTracePly.phase`.
   * Используется фронтом для фазовой свёртки агрегатов; backend
   * подаёт значение модели вместе с metrics для контекста (дебют /
   * эндшпиль).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(256)
  phase?: number;
}
