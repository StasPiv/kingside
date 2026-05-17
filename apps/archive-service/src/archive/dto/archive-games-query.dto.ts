import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type {
  ArchiveGameResult,
  ArchiveGamesRequest,
  ArchiveGamesSortMetadata,
  ArchiveTimeControlCategory,
} from '@kingside/shared';

const RESULT_VALUES: ArchiveGameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const SORT_VALUES: ArchiveGamesSortMetadata[] = ['recent', 'topElo', 'oldest'];
const TIME_CONTROL_CATEGORY_VALUES: ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
];

export class ArchiveGamesQueryDto implements ArchiveGamesRequest {
  /**
   * KS-3088: НЕ используется здесь. `/archive/games` фильтрует по
   * metadata-полям (player/eco/event/elo/dates/ply/result/sort);
   * per-position поиск живёт в отдельном эндпоинте
   * `GET /archive/games/by-position?fen=...` (через
   * `archive_position_stats`). Если поле приходит — сервис вернёт
   * `400 fen_filter_not_supported` с указанием правильного маршрута.
   * Оставлено в DTO ради явной 400-ошибки и для обратной совместимости
   * клиентов, переключающихся на by-position (KS-3087).
   */
  @IsOptional()
  @IsString()
  fen?: string;

  /** KS-3088: см. комментарий выше для `fen` — тот же режим (400). */
  @IsOptional()
  @IsString()
  move?: string;

  @IsOptional()
  @IsString()
  white?: string;

  @IsOptional()
  @IsString()
  black?: string;

  /**
   * KS-2081: фильтр по игроку, поддерживает 1..N substring'ов.
   *
   * Express парсит `?player=A&player=B` как массив строк, а одиночное
   * `?player=A` — как строку. Здесь нормализуем оба варианта в массив,
   * чтобы downstream-логика (service / SQL builder) была однообразной.
   * Лимит 5 — защита от случайного дисбаланса (запросов с 5+ AND-ветками
   * не предусмотрено UX).
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  player?: string[];

  @IsOptional()
  @IsString()
  eco?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4000)
  minElo?: number;

  @IsOptional()
  @IsIn(RESULT_VALUES)
  result?: ArchiveGameResult;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @IsString()
  event?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  minPly?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  maxPly?: number;

  /**
   * KS-2118: фильтр по категории контроля времени.
   *
   * Express парсит `?timeControlCategory=classical&timeControlCategory=rapid`
   * как массив строк, одиночное `?timeControlCategory=blitz` — как строку.
   * Нормализуем оба варианта в массив. Лимит 5 — по числу допустимых
   * значений (`bullet|blitz|rapid|classical|unknown`); защита от
   * случайных дублей.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsIn(TIME_CONTROL_CATEGORY_VALUES, { each: true })
  timeControlCategory?: ArchiveTimeControlCategory[];

  @IsOptional()
  @IsIn(SORT_VALUES)
  sort?: ArchiveGamesSortMetadata;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /**
   * KS-2142. Keyset cursor для пагинации (base64-encoded). Если задан —
   * `offset` игнорируется (приоритет cursor). Декодирование — в сервисе
   * через `decodeCursor` из `cursor-codec.ts`. Невалидная/чужая для
   * текущего sort строка → молча игнорируется (fallback на первую страницу).
   */
  @IsOptional()
  @IsString()
  cursor?: string;
}
