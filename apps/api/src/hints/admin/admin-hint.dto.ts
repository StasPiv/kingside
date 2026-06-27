/**
 * KS-4702 / ADR-147 §3.1 + §3.3. DTO для админ-CRUD `Hint`.
 *
 * Жёсткие лимиты по полям соответствуют схеме events.hints:
 *   - `key`: 1..64 ASCII-safe (`[a-z][a-z0-9-]*`), УНИКАЛЕН.
 *   - `anchor`: должен быть из HINT_ANCHORS (shared T7). Валидируем
 *     через `isHintAnchor` на runtime, чтобы новые anchors требовали
 *     обновления типов.
 *   - `placement`: 'top'|'bottom'|'left'|'right'|'overlay'|'bottom-sheet'.
 *   - `i18n`: объект с локалями ru/en, каждая — {title, body, ctaLabel?}.
 *   - `cta`: {href?,event?} либо null/отсутствует.
 *   - `rule`: jsonb DSL (валидируется отдельно через
 *     `hints-dsl.evaluator.validateRule` → бросает 400 с message).
 *   - `acceptedBy`: string[] из event-type'ов для smart-dismiss.
 *   - `targetActorTypes`: string[] из ['user', 'guest'].
 *   - `priority/cooldownSec/ttlSec/maxShows`: numerics с разумными
 *     min/max-границами.
 *
 * Все строки i18n проходят через `stripHtml` (см. blog/comment-sanitize)
 * на стороне service'а — не в DTO, чтобы не дублировать (валидатор и
 * sanitize — две разные ответственности).
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class HintI18nEntryDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 1000)
  body!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  ctaLabel?: string;
}

export class HintI18nDto {
  @IsOptional()
  @IsObject()
  ru?: HintI18nEntryDto;

  @IsOptional()
  @IsObject()
  en?: HintI18nEntryDto;
}

export class HintCtaDto {
  @IsOptional()
  @IsString()
  @Length(1, 256)
  href?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  event?: string;
}

export const HINT_PLACEMENTS = [
  'top', 'bottom', 'left', 'right', 'overlay', 'bottom-sheet',
] as const;

export class CreateHintDto {
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z][a-z0-9-]*$/, {
    message: 'key must match /^[a-z][a-z0-9-]*$/ (1..64)',
  })
  key!: string;

  @IsObject()
  i18n!: HintI18nDto;

  @IsOptional()
  @IsObject()
  cta?: HintCtaDto;

  @IsString()
  @Length(1, 64)
  anchor!: string;

  @IsIn(HINT_PLACEMENTS as unknown as string[])
  placement!: typeof HINT_PLACEMENTS[number];

  @IsObject()
  rule!: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @ArrayUnique()
  acceptedBy?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ArrayUnique()
  targetActorTypes?: Array<'user' | 'guest'>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(31_536_000)
  cooldownSec?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  ttlSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxShows?: number;
}

/**
 * Полный update (PUT). Те же поля, что Create, все опциональны: фронт
 * шлёт «снимок состояния», бэк перезаписывает указанное.
 */
export class UpdateHintDto {
  @IsOptional()
  @IsObject()
  i18n?: HintI18nDto;

  @IsOptional()
  @IsObject()
  cta?: HintCtaDto | null;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  anchor?: string;

  @IsOptional()
  @IsIn(HINT_PLACEMENTS as unknown as string[])
  placement?: typeof HINT_PLACEMENTS[number];

  @IsOptional()
  @IsObject()
  rule?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @ArrayUnique()
  acceptedBy?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ArrayUnique()
  targetActorTypes?: Array<'user' | 'guest'>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(31_536_000)
  cooldownSec?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  ttlSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxShows?: number;
}

export class UpdateHintStatusDto {
  @IsBoolean()
  enabled!: boolean;
}

/**
 * `POST /admin/hints/preview-trigger { rule }` → возвращает оценку
 * сколько уникальных actor'ов из последних 24h подпало бы под правило.
 * Полноценный «сейчас попал бы» требовал бы полного скана events за
 * нужное окно — это дорого. Преview работает на актуальном
 * actor_event_counts_24h matview (быстро) — подсчёт N уникальных
 * actor_id, у которых выполнятся все простые предикаты count/exists.
 *
 * Намеренно простая эвристика — для UI «приблизительно сколько
 * пользователей», точный счёт не требуется (правило всё равно сработает
 * в рантайме reactively по событию).
 */
export class PreviewTriggerDto {
  @IsObject()
  rule!: Record<string, unknown>;
}
