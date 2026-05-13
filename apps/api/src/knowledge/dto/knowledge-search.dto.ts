import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import {
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
} from '../knowledge.config';

/**
 * KS-2967 / ADR-063 §6.4 — query параметры для `GET /knowledge/search`.
 *
 * `q` — fixed-string поиск (ripgrep -F), без regex по соображениям
 * безопасности (ReDoS) и предсказуемости результата. `glob` опционально
 * сужает зону поиска внутри allowlist'а. `limit` — cap на число
 * результатов (default 20, max 100).
 */
export class KnowledgeSearchDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  q!: string;

  /**
   * Опциональный glob-фильтр путей (относительно REPO_ROOT). Должен
   * лежать в пределах allowlist'а — иначе результат будет пустым.
   * Пример: `apps/web/src/pages/Archive*.tsx`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  glob?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KNOWLEDGE_SEARCH_MAX_LIMIT)
  limit?: number = KNOWLEDGE_SEARCH_DEFAULT_LIMIT;
}
