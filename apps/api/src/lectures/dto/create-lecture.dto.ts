import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
} from '@kingside/shared';

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

  /**
   * KS-3934 / ADR-118 §2.1. Видимость лекции при создании.
   *   - `public` — публичная (видна в списке тренера).
   *   - `unlisted` — по прямой ссылке.
   *   - `restricted` — только владелец + allowlist (см. `initialAccessUserIds`).
   */
  @IsOptional()
  @IsIn(['public', 'unlisted', 'restricted'])
  visibility?: 'public' | 'unlisted' | 'restricted';

  /**
   * KS-3934 / ADR-118 §2.4.1. Опционально на создании restricted-лекции:
   * userId-ы, которым сразу выдать доступ. Без поля или пустой массив —
   * лекция создаётся открытой только для владельца, allowlist пуст
   * (тренер добавит учеников через `POST /lectures/:id/access` позже).
   *
   * Если visibility != 'restricted' — массив игнорируется (warn в логе).
   * Дубликаты в массиве защищены `ArrayUnique` на DTO, а bulk INSERT
   * использует `skipDuplicates: true` как вторая страховка.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  initialAccessUserIds?: string[];

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

  /**
   * KS-3899 / ADR-117 §2. Инструменты, отключённые тренером для
   * учеников live-сессии. Опционально на создании — без поля или
   * пустой массив означает «ничего не отключено». Whitelist значений
   * — `ALL_LECTURE_DISABLED_TOOLS` (см. `@kingside/shared`). Невалидное
   * значение в массиве → 400.
   *
   * `ArrayUnique` страхует от дубликатов («engine», «engine») — БД
   * хранит `text[]` без констрейнта уникальности, контракт же
   * ожидает множество.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_LECTURE_DISABLED_TOOLS as readonly string[], { each: true })
  disabledTools?: LectureDisabledTool[];

  /**
   * KS-4039. Скрыть блок «Метрики» (позиционные подкомпоненты Stockfish)
   * у зрителей-учеников в режиме лекции. Опционально на создании —
   * без поля Prisma подставит DB-default `false`. Тренер всегда видит
   * блок независимо от значения.
   */
  @IsOptional()
  @IsBoolean()
  hideMetricsTab?: boolean;
}

/**
 * KS-3785/KS-3789. Body для `POST /lectures/:id/start`.
 *
 * KS-4000 / часть backend: поле `analysisId` теперь ОБЯЗАТЕЛЬНОЕ.
 * Согласовано с пользователем: запуск live-эфира остаётся только из
 * окна анализа, чтобы тренер не терял наработки в пустом анализе.
 * Сценарий «start без analysisId» отвергается с 400.
 */
export class StartLectureDto {
  @IsUUID('4')
  analysisId!: string;
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

  /**
   * KS-3933 / ADR-118 §2.1, §2.4.1. Видимость лекции. Список значений
   * расширен на `'restricted'` (allowlist-доступ). В отличие от других
   * полей DTO (которые `scheduled`-only), `visibility` после A04
   * правится в любом статусе — тренер может закрыть/открыть лекцию
   * прямо во время `live` или после `recorded`. Allowlist при
   * переключении `restricted → public/unlisted` сохраняется в
   * `lecture_access_grants` (на случай отката).
   */
  @IsOptional()
  @IsIn(['public', 'unlisted', 'restricted'])
  visibility?: 'public' | 'unlisted' | 'restricted';

  /**
   * KS-3899 / ADR-117 §2. Полный новый набор отключённых инструментов
   * (НЕ дельта). Пустой массив = снять все ограничения. Whitelist —
   * `ALL_LECTURE_DISABLED_TOOLS`. Изменения тренером публикуются всем
   * подписчикам live-сессии через WS-событие
   * `live-analysis:lecture-tools` (KS-3896 D01).
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_LECTURE_DISABLED_TOOLS as readonly string[], { each: true })
  disabledTools?: LectureDisabledTool[];

  /**
   * KS-4039. Скрыть/показать блок «Метрики» у зрителей-учеников.
   * Разрешён в любом статусе лекции (как `disabledTools` и
   * `visibility` — KS-3900/KS-3933).
   */
  @IsOptional()
  @IsBoolean()
  hideMetricsTab?: boolean;
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

/**
 * KS-3937 / ADR-118 §2.4.1. Query для `GET /my/lectures`.
 *
 * `status` — опциональный фильтр; `limit` / `offset` — пагинация
 * (limit clamp'ится сервисом до [1..100], offset до >=0).
 *
 * Все числа приходят как строки в query — конвертируем `@Type(() => Number)`,
 * валидируем `@Min` / `@Max` для подсказки клиенту, итоговую защиту
 * от out-of-range выполняет сервис.
 */
export class MyLecturesQueryDto {
  @IsOptional()
  @IsIn(['scheduled', 'live', 'recorded', 'cancelled'])
  status?: 'scheduled' | 'live' | 'recorded' | 'cancelled';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
