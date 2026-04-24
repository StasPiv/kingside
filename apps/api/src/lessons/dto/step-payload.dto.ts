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
  IsUUID,
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
  EndgameDrillStepPayload,
  EndgameWinCondition,
  QuizQuestion,
  QuizOption,
  PuzzleTheme,
} from '@kingside/shared';
import { ArePositionMovesLegal, IsFen } from './position-step.validators';
import { IsVideoUrl } from './video-step.validators';
import { IsGameReviewXor, IsValidPgn } from './game-review-step.validators';
import { IsEndgameWinCondition } from './endgame-drill-step.validators';

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

/**
 * Интерактивная позиция (итерация 2, L-23).
 *
 * Доменные проверки (FEN + легальность UCI-ходов) вынесены в кастомные
 * декораторы `@IsFen` / `@ArePositionMovesLegal` — те же функции использует
 * seed-линтер (см. `../seed/lint.ts`), так что словарь ошибок одинаковый
 * у рантайм-валидации API и у pre-seed-проверки.
 */
class PositionStepPayloadDto implements PositionStepPayload {
  @IsIn(['position'])
  type!: 'position';

  @IsString()
  @IsFen()
  fen!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @ArePositionMovesLegal('fen')
  expectedMoves!: string[];

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';
}

/**
 * Разбор партии (L-30 / KS-1811). Автор шага обязан указать ровно один
 * источник партии: `gameId` (UUID записи игры в нашей БД) ИЛИ `pgn`
 * (непустая строка, парсящаяся `chess.js#loadPgn`). Пустой payload
 * запрещён на уровне DTO и seed-линтера — UX-ветка «empty + импорт»
 * на фронте не соответствует контенту урока.
 */
class GameReviewStepPayloadDto implements GameReviewStepPayload {
  @IsIn(['game_review'])
  @IsGameReviewXor()
  type!: 'game_review';

  @IsOptional()
  @IsUUID()
  gameId?: string;

  @IsOptional()
  @IsString()
  @IsValidPgn()
  pgn?: string;
}

/**
 * Видео-шаг (L-34 / KS-1796 / KS-1808). `url` ограничен whitelist'ом
 * хостов YouTube/Vimeo и http(s)-схемой — чтобы iframe на фронте не
 * рендерил произвольные ресурсы. Сам словарь хостов — в
 * `@kingside/shared` (`ALLOWED_VIDEO_HOSTS`), используется тем же
 * helper'ом и в seed-линтере.
 */
class VideoStepPayloadDto implements VideoStepPayload {
  @IsIn(['video'])
  type!: 'video';

  @IsString()
  @IsVideoUrl()
  url!: string;

  @IsOptional()
  @IsString()
  titleI18nKey?: string;
}

/**
 * Эндшпильный тренажёр (L-24 / KS-1800 frontend / KS-1815 backend).
 * `winCondition` — дискриминированный union, проверка унифицирована
 * через `@IsEndgameWinCondition()` (та же функция используется
 * seed-линтером).
 */
class EndgameDrillStepPayloadDto implements EndgameDrillStepPayload {
  @IsIn(['endgame_drill'])
  type!: 'endgame_drill';

  @IsString()
  @IsFen()
  fen!: string;

  @IsIn(['white', 'black'])
  playerSide!: 'white' | 'black';

  @IsInt()
  @Min(0)
  @Max(20)
  skillLevel!: number;

  @IsEndgameWinCondition()
  winCondition!: EndgameWinCondition;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxMoves?: number;

  @IsOptional()
  @IsBoolean()
  hintsAllowed?: boolean;
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
  { value: EndgameDrillStepPayloadDto, name: 'endgame_drill' },
] as const;

export type StepPayloadDto =
  | TextStepPayloadDto
  | PuzzleStepPayloadDto
  | QuizStepPayloadDto
  | PositionStepPayloadDto
  | GameReviewStepPayloadDto
  | VideoStepPayloadDto
  | EndgameDrillStepPayloadDto;

export {
  TextStepPayloadDto,
  PuzzleStepPayloadDto,
  QuizStepPayloadDto,
  PositionStepPayloadDto,
  GameReviewStepPayloadDto,
  VideoStepPayloadDto,
  EndgameDrillStepPayloadDto,
  QuizQuestionDto,
  QuizOptionDto,
  PuzzleSelectionIdsDto,
  PuzzleSelectionFilterDto,
};
