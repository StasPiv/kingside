import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * KS-3784 / ADR-113 §4 эпик 1. Тело `POST /lectures`.
 *
 * `scheduledAt` опционален: без него лекция сразу переводится в
 * `status='live'` и для неё создаётся свежая `LiveAnalysis` (сценарий
 * «начать сейчас» из AnalysisPage в KS-3789). С `scheduledAt` —
 * запланированная лекция в статусе `scheduled`, переход в live
 * выполняется через `POST /lectures/:id/start`.
 */
export class CreateLectureDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** ISO-8601. Без поля → лекция стартует немедленно как `live`. */
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  /** `public` (видна в списке тренера) или `unlisted` (только по прямой ссылке). */
  @IsOptional()
  @IsIn(['public', 'unlisted'])
  visibility?: 'public' | 'unlisted';

  /**
   * KS-3785/KS-3789: при immediate-live (без `scheduledAt`) можно
   * привязать лекцию к конкретному `Analysis`. Тогда созданная под
   * лекцию `LiveAnalysis` идёт через `LiveAnalysisService.create`
   * (ADR-112): проверяется владелец анализа, действует идемпотентность
   * по `(ownerId, analysisId)` (если у владельца уже есть active
   * сессия на этот анализ — лекция привяжется к ней), и
   * `GET /live-analyses/by-analysis/:analysisId` потом найдёт её.
   *
   * Без `analysisId` лекция создаётся через
   * `createBareLiveSession` — без привязки к `Analysis`.
   */
  @IsOptional()
  @IsUUID('4')
  analysisId?: string;
}

/**
 * KS-3785/KS-3789. Body для `POST /lectures/:id/start`. Опциональное
 * поле `analysisId` — то же значение, что и в `CreateLectureDto`.
 */
export class StartLectureDto {
  @IsOptional()
  @IsUUID('4')
  analysisId?: string;
}

/**
 * KS-3800 / ADR-113 §4 крупная задача 3. Body для `PATCH /lectures/:id`.
 *
 * Все поля опциональные — PATCH-семантика: изменяется только то, что
 * передано. Доступно только для лекции в статусе `scheduled`: сервис
 * вернёт 400, если статус другой. `scheduledAt` нельзя двигать на
 * already-live/recorded — то же правило.
 *
 * Поле `status` намеренно отсутствует: переход в `live` делает
 * `POST /lectures/:id/start`, в `recorded` — финализатор записи, в
 * `cancelled` — `POST /lectures/:id/cancel`.
 */
export class UpdateLectureDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsIn(['public', 'unlisted'])
  visibility?: 'public' | 'unlisted';
}

/**
 * KS-3801 / ADR-113 §4 крупная задача 3. Query для
 * `GET /coaches/:username/schedule?from&to`.
 *
 * `from` / `to` — ISO-8601 границы окна, обе опциональные. Без них
 * выборка не ограничена по времени (вернёт все scheduled+live
 * лекции тренера). Если задано только `from` — открытое окно вправо,
 * если только `to` — открытое окно влево.
 */
export class ScheduleQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
