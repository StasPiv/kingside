import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Matches,
  Max,
  MaxLength,
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
  OpeningDrillStepPayload,
  QuizQuestion,
  QuizOption,
  PuzzleTheme,
  CustomPuzzle,
  DrillStepPayload,
  DrillDifficultyBucket,
  TacticDrillType,
} from '@kingside/shared';
import { ArePositionMovesLegal, IsFen } from './position-step.validators';
import { IsVideoUrl } from './video-step.validators';
import { IsGameReviewXor, IsValidPgn } from './game-review-step.validators';
import { IsEndgameWinCondition } from './endgame-drill-step.validators';
import { IsDrillPgn } from './opening-drill-step.validators';
import { IsCustomPuzzlesArray } from './custom-puzzle.validators';
import { IsValidDrillStepPayload } from './drill-step.validators';

// ─── Базовые подтипы ──────────────────────────────────────────────────

// KS-1994: формат клетки `[a-h][1-8]`. Используется и для arrows,
// и для highlightedSquares. Цвет — опц. CSS-строка (FE сам решает,
// какие значения принимать).
const SQUARE_REGEX = /^[a-h][1-8]$/;

class DiagramArrowDto {
  @IsString()
  @Matches(SQUARE_REGEX, { message: 'arrow.from must be a square in [a-h][1-8]' })
  from!: string;

  @IsString()
  @Matches(SQUARE_REGEX, { message: 'arrow.to must be a square in [a-h][1-8]' })
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;
}

class DiagramHighlightDto {
  @IsString()
  @Matches(SQUARE_REGEX, {
    message: 'highlightedSquares.square must be a square in [a-h][1-8]',
  })
  square!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;
}

class TextDiagramDto {
  @IsString()
  fen!: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';

  /** KS-1994: стрелки на диаграмме. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => DiagramArrowDto)
  arrows?: DiagramArrowDto[];

  /** KS-1994: подсвеченные клетки. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => DiagramHighlightDto)
  highlightedSquares?: DiagramHighlightDto[];
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

/**
 * KS-1908 / ADR-029: третий вариант selection — авторские задачи.
 * `customPuzzles` — массив самодостаточных описаний (FEN +
 * solutionMoves + опц. orientation/themes/caption). chess.js-валидация
 * пошагово делается в `@IsCustomPuzzlesArray()`. Длина массива и
 * каждого `solutionMoves` ограничены в `USER_COURSES_LIMITS`.
 */
class PuzzleSelectionCustomDto {
  @IsIn(['custom'])
  mode!: 'custom';

  @IsCustomPuzzlesArray()
  customPuzzles!: CustomPuzzle[];
}

class PuzzleStepPayloadDto implements PuzzleStepPayload {
  @IsIn(['puzzle'])
  type!: 'puzzle';

  /**
   * Дискриминируется по полю `mode` (`ids` | `filter` | `custom`).
   * KS-1908 / ADR-029: добавлен `custom` — авторские задачи прямо в
   * payload, без ссылок на системную puzzle-БД.
   *
   * class-transformer выбирает subType по совпадению `mode`-значения
   * со `name` варианта; неизвестный `mode` оставит объект без
   * вложенной валидации, и валидаторы родителя пропустят его как
   * «непрошедший discriminator». Семантически это валит шаг через
   * родительский DTO (поле `selection` не получит инстанса своего
   * подкласса).
   */
  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'mode',
      subTypes: [
        { value: PuzzleSelectionIdsDto, name: 'ids' },
        { value: PuzzleSelectionFilterDto, name: 'filter' },
        { value: PuzzleSelectionCustomDto, name: 'custom' },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  selection!:
    | PuzzleSelectionIdsDto
    | PuzzleSelectionFilterDto
    | PuzzleSelectionCustomDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSolved?: number;
}

class QuizOptionDto implements QuizOption {
  @IsString()
  id!: string;

  /** KS-1982: текст варианта инлайном — единственный источник. */
  @IsString()
  label!: string;
}

class QuizQuestionDto implements QuizQuestion {
  @IsString()
  id!: string;

  /** KS-1982: текст вопроса инлайном. */
  @IsString()
  prompt!: string;

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

  /** Опц.: разбор после ответа. Не у всех вопросов есть. */
  @IsOptional()
  @IsString()
  explanation?: string;
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

  /**
   * KS-1983: `expectedMoves` опциональны. Если не передано или пусто —
   * шаг работает как read-only показ позиции. Если передано — каждый
   * UCI-ход всё ещё валидируется на легальность от `fen` (старое
   * поведение через `@ArePositionMovesLegal`).
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArePositionMovesLegal('fen')
  expectedMoves?: string[];

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

/**
 * Дебютный тренажёр (L-32 / KS-1801 frontend / KS-1816 backend).
 * PGN-дерево парсится `chess.js#loadPgn`, `onDeviation` управляет
 * реакцией на уход из теории.
 */
class OpeningDrillStepPayloadDto implements OpeningDrillStepPayload {
  @IsIn(['opening_drill'])
  type!: 'opening_drill';

  @IsString()
  @IsDrillPgn()
  pgn!: string;

  @IsIn(['white', 'black'])
  playerSide!: 'white' | 'black';

  @IsIn(['show_correction', 'engine_punish'])
  onDeviation!: 'show_correction' | 'engine_punish';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  engineSkillLevel?: number;
}

/**
 * KS-2249 (ADR-035 §11 / E6) — drill-шаг урока.
 * Тактический drill в составе lesson player'а: использует ту же
 * predicate-инфраструктуру и rating, что и автономный режим, но
 * рендерится как очередной step урока. Поля задокументированы в
 * `@kingside/shared#DrillStepPayload`.
 *
 * `@IsValidDrillStepPayload` — cross-field валидация (drillType ∈
 * TacticDrillType, count/minSolved consistency, UUID-формат drillId,
 * bucket-whitelist) — общий с seed-линтером словарь ошибок.
 */
class DrillStepPayloadDto implements DrillStepPayload {
  @IsIn(['drill'])
  type!: 'drill';

  @IsString()
  @IsIn([
    'find-hanging-piece',
    'find-loose-piece',
    'find-pin',
    'find-fork',
    'find-mate-in-one-square',
    'count-attackers',
    'find-all-checks',
    'find-undefended-attack',
  ])
  drillType!: TacticDrillType;

  @IsOptional()
  @IsUUID()
  drillId?: string;

  @IsOptional()
  @IsIn(['easy', 'medium', 'hard'])
  difficultyBucket?: DrillDifficultyBucket;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  count?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  minSolved?: number;

  /**
   * Cross-field проверка: `minSolved ≤ count`, единый словарь ошибок с
   * seed-линтером. Висит на `type` (только потому, что валидатор работает
   * с целым объектом — `args.object`, поле любое).
   */
  @IsValidDrillStepPayload()
  __crossField?: never;
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
  { value: OpeningDrillStepPayloadDto, name: 'opening_drill' },
  { value: DrillStepPayloadDto, name: 'drill' },
] as const;

export type StepPayloadDto =
  | TextStepPayloadDto
  | PuzzleStepPayloadDto
  | QuizStepPayloadDto
  | PositionStepPayloadDto
  | GameReviewStepPayloadDto
  | VideoStepPayloadDto
  | EndgameDrillStepPayloadDto
  | OpeningDrillStepPayloadDto
  | DrillStepPayloadDto;

export {
  TextStepPayloadDto,
  PuzzleStepPayloadDto,
  QuizStepPayloadDto,
  PositionStepPayloadDto,
  GameReviewStepPayloadDto,
  VideoStepPayloadDto,
  EndgameDrillStepPayloadDto,
  OpeningDrillStepPayloadDto,
  DrillStepPayloadDto,
  QuizQuestionDto,
  QuizOptionDto,
  PuzzleSelectionIdsDto,
  PuzzleSelectionFilterDto,
  PuzzleSelectionCustomDto,
};
