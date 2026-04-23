import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  TextStepPayload,
  PuzzleStepPayload,
  QuizStepPayload,
  PositionStepPayload,
  GameReviewStepPayload,
  VideoStepPayload,
  QuizQuestion,
  QuizOption,
  PuzzleTheme,
} from '@kingside/shared';

// ─── Базовые подтипы ──────────────────────────────────────────────────

class TextDiagramDto {
  @IsString()
  fen!: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';
}

class TextStepPayloadDto implements TextStepPayload {
  @IsIn(['text'])
  type!: 'text';

  @IsOptional()
  @IsString()
  bodyI18nKey?: string;

  @IsOptional()
  @IsString()
  bodyMarkdown?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TextDiagramDto)
  diagrams?: TextDiagramDto[];
}

class PuzzleSelectionIdsDto {
  @IsIn(['ids'])
  mode!: 'ids';

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  puzzleIds!: string[];
}

class PuzzleSelectionFilterDto {
  @IsIn(['filter'])
  mode!: 'filter';

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  themes!: PuzzleTheme[];

  @IsOptional()
  @IsInt()
  @Min(0)
  ratingMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  ratingMax?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  limit!: number;
}

class PuzzleStepPayloadDto implements PuzzleStepPayload {
  @IsIn(['puzzle'])
  type!: 'puzzle';

  /**
   * Дискриминируется по полю `mode` (`ids` | `filter`). Для class-validator мы
   * валидируем оба варианта через union: если у объекта `mode==='ids'` —
   * ожидаем `puzzleIds`, иначе — фильтр. Проверка выполняется в
   * {@link validateSelection} ниже (класс-валидатор не умеет discriminated union
   * без кастомного decorator'а).
   */
  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'mode',
      subTypes: [
        { value: PuzzleSelectionIdsDto, name: 'ids' },
        { value: PuzzleSelectionFilterDto, name: 'filter' },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  selection!: PuzzleSelectionIdsDto | PuzzleSelectionFilterDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSolved?: number;
}

class QuizOptionDto implements QuizOption {
  @IsString()
  id!: string;

  @IsString()
  labelI18nKey!: string;
}

class QuizQuestionDto implements QuizQuestion {
  @IsString()
  id!: string;

  @IsString()
  promptI18nKey!: string;

  @IsOptional()
  @IsString()
  fen?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  options!: QuizOptionDto[];

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  correctOptionIds!: string[];

  @IsOptional()
  @IsBoolean()
  multi?: boolean;

  @IsOptional()
  @IsString()
  explanationI18nKey?: string;
}

class QuizStepPayloadDto implements QuizStepPayload {
  @IsIn(['quiz'])
  type!: 'quiz';

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionDto)
  questions!: QuizQuestionDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  passThreshold?: number;
}

// ─── Заглушки под следующие итерации (валидация минимальная) ─────────

class PositionStepPayloadDto implements PositionStepPayload {
  @IsIn(['position'])
  type!: 'position';

  @IsString()
  fen!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  expectedMoves!: string[];

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';
}

class GameReviewStepPayloadDto implements GameReviewStepPayload {
  @IsIn(['game_review'])
  type!: 'game_review';

  @IsOptional()
  @IsString()
  gameId?: string;

  @IsOptional()
  @IsString()
  pgn?: string;
}

class VideoStepPayloadDto implements VideoStepPayload {
  @IsIn(['video'])
  type!: 'video';

  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  titleI18nKey?: string;
}

// ─── Discriminated union wrapper ─────────────────────────────────────

/**
 * Список всех вариантов `StepPayload` — для `@Type` decorator'а
 * с discriminator по полю `type`. Используется в DTO на входе, когда
 * endpoint принимает `payload` (seed API / будущий редактор).
 */
export const STEP_PAYLOAD_SUBTYPES = [
  { value: TextStepPayloadDto, name: 'text' },
  { value: PuzzleStepPayloadDto, name: 'puzzle' },
  { value: QuizStepPayloadDto, name: 'quiz' },
  { value: PositionStepPayloadDto, name: 'position' },
  { value: GameReviewStepPayloadDto, name: 'game_review' },
  { value: VideoStepPayloadDto, name: 'video' },
] as const;

export type StepPayloadDto =
  | TextStepPayloadDto
  | PuzzleStepPayloadDto
  | QuizStepPayloadDto
  | PositionStepPayloadDto
  | GameReviewStepPayloadDto
  | VideoStepPayloadDto;

export {
  TextStepPayloadDto,
  PuzzleStepPayloadDto,
  QuizStepPayloadDto,
  PositionStepPayloadDto,
  GameReviewStepPayloadDto,
  VideoStepPayloadDto,
  QuizQuestionDto,
  QuizOptionDto,
  PuzzleSelectionIdsDto,
  PuzzleSelectionFilterDto,
};
