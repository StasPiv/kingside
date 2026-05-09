/**
 * KS-2646 / ADR-054 Phase D fix — унифицированные body-DTO для
 * `POST /lessons/progress/lessons/:lessonId/{step,complete}`.
 *
 * Старая системная форма (`POST /lessons/progress/step` с lessonId в
 * body) остаётся для обратной совместимости — `UpdateStepProgressDto`
 * / `CompleteLessonDto`. Новая форма соответствует пользовательскому
 * URL-шаблону `/lessons/:lessonId/...` (см.
 * `Adr054UnifiedProgressController`), но в одном маршруте обслуживает
 * и системные и пользовательские уроки. Отличия от пользовательских
 * DTO:
 *   * `step`-DTO без поля `score` (системный сервис его не принимает,
 *     puzzle-attempt пишется отдельным эндпоинтом);
 *   * `complete`-DTO принимает опциональный `quality` (0..5), нужный
 *     для SM-2 на системных уроках. Для пользовательских урок quality
 *     игнорируется (см. ADR-054 §3.2 п.7).
 */

import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class Adr054UnifiedStepProgressBody {
  @IsUUID()
  stepId!: string;

  @IsIn(['done', 'failed', 'skipped'])
  state!: 'done' | 'failed' | 'skipped';
}

export class Adr054UnifiedCompleteLessonBody {
  @IsNumber()
  @Min(0)
  @Max(1)
  score!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  quality?: number;
}
