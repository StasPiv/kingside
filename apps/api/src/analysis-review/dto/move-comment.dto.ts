/**
 * KS-3711. DTO для `POST /analyses/review/move-comment` — комментарий
 * к одному ходу в режиме «Полный разбор партии». Заменяет пакетный
 * `BatchCommentDto` из `/analyses/review/comments` (старый эндпоинт
 * остаётся рабочим до миграции фронта в KS-3712).
 *
 * Структура: для каждого «интересного» хода фронт собирает пару
 * снимков позиции (`before` / `after`) в формате `position-comment`
 * (FEN + массив позиционных факторов из вывода Stockfish-trace
 * `eval json` + опциональная финальная оценка `total`). Модель видит
 * оценку и факторы ДО и ПОСЛЕ хода и комментирует именно изменение,
 * а не статическую позицию.
 *
 * `move` — сам сыгранный ход (san/uci + признаки взятия/шаха/мата/
 * рокировки/превращения) и классификация Stockfish + Maia (best/good/
 * inaccuracy/mistake/blunder).
 *
 * Парные снимки `before` / `after` используют ту же shape, что
 * `PositionCommentDto` (см. `apps/api/src/position-comment/dto/
 * position-comment.dto.ts`); `factors` — массив `unknown` (фронт-форк
 * Stockfish-trace может опередить бэк по списку идентификаторов
 * подкомпонент, поэтому whitelist не применяется здесь — он
 * применяется в инструкции модели через словарь расшифровок
 * `SUBTERM_LABELS`).
 */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { PositionEvalDto } from '../../position-comment/dto/position-comment.dto';

const MOVE_COMMENT_LANG = ['ru', 'en'] as const;
export type MoveCommentLanguage = (typeof MOVE_COMMENT_LANG)[number];

const MOVE_CLASS = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
] as const;
const CASTLING = ['O-O', 'O-O-O'] as const;

/**
 * Описание сыгранного хода. Поля повторяют `MoveDescriptorDto` из
 * `BatchCommentDto`/`MoveFactsDto` (KS-3615), плюс `classification`
 * вынесена сюда (раньше была на уровне факта). Required-поля минимальны:
 * `san` и `uci` — без них хода нет; `check` — boolean (false для тихого);
 * `classification` — обязательна, иначе модель не знает уровня ошибки.
 */
export class MovePayloadDto {
  @IsString()
  san!: string;

  @IsString()
  uci!: string;

  @IsOptional()
  @IsString()
  capture?: string | null;

  @IsBoolean()
  check!: boolean;

  /**
   * Реальная дистанция мата в полуходах (positive — мат объявляет
   * ходивший, negative — мат против него). KS-3710: на матовых ходах
   * фронт раньше клал `0`, что эквивалентно «не мат» — поправляется
   * в KS-3712. Здесь `null` означает «нет мат-объявления этим ходом».
   */
  @IsOptional()
  @IsInt()
  mate?: number | null;

  @IsOptional()
  @IsIn(CASTLING as readonly string[])
  castling?: 'O-O' | 'O-O-O' | null;

  @IsOptional()
  @IsString()
  promotion?: string | null;

  @IsIn(MOVE_CLASS as readonly string[])
  classification!: (typeof MOVE_CLASS)[number];
}

/**
 * Снимок позиции в формате `position-comment`: FEN + массив
 * позиционных факторов (`sf18_eval`, `sf18_pv`, `positional_subterms`
 * со всеми `value_*`/`terminal_value_*`, `tactical_motifs`,
 * `hanging_piece`, `threats_*` и т. д., в виде, в котором их собирает
 * `extractFacts.ts` на фронте) + опциональная финальная оценка `total`
 * из вывода `eval json` нашей версии Stockfish-trace.
 *
 * Shape сохраняется идентичной `PositionCommentDto` — намеренно: фронт
 * переиспользует один и тот же сборщик фактов на оба снимка (ДО и
 * ПОСЛЕ хода), бэк прокидывает их в инструкцию модели без
 * перетрансформации.
 */
export class PositionSnapshotDto {
  @IsString()
  fen!: string;

  @IsArray()
  factors!: unknown[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PositionEvalDto)
  eval?: PositionEvalDto;
}

/**
 * Тело запроса `POST /analyses/review/move-comment`. Один запрос — один
 * комментарий на один ход. Фронт сам решает, какие ходы «интересные»
 * (взятия / шахи / маты / превращения / рокировки / ошибки), и для
 * каждого формирует пару снимков `before` / `after`. Тихие ходы без
 * сигналов не комментируются — запрос не отправляется.
 *
 * `language` — `'ru'` или `'en'`. По умолчанию `'ru'`, как в
 * `PositionCommentDto`.
 */
export class MoveCommentDto {
  @IsObject()
  @ValidateNested()
  @Type(() => MovePayloadDto)
  move!: MovePayloadDto;

  @IsObject()
  @ValidateNested()
  @Type(() => PositionSnapshotDto)
  before!: PositionSnapshotDto;

  @IsObject()
  @ValidateNested()
  @Type(() => PositionSnapshotDto)
  after!: PositionSnapshotDto;

  @IsOptional()
  @IsIn(MOVE_COMMENT_LANG as readonly string[])
  language?: MoveCommentLanguage;
}
