import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { StudyFocus } from '@kingside/shared';

/** Допустимые значения focus (ADR-160 §2.4). */
export const STUDY_FOCUS_VALUES: StudyFocus[] = [
  'tactics',
  'openings',
  'endgames',
  'balanced',
];

/** KS-4927 / ADR-163 §2: лимит тренировок на пользователя. */
export const MAX_SCHEDULES_PER_USER = 5;
/** KS-4927 / ADR-163 §2: лимит слотов на тренировку. */
export const MAX_SLOTS_PER_SCHEDULE = 7;

/**
 * KS-4927 / ADR-163 §5. Слот в теле POST/PUT /study/schedules:
 * дни недели + локальное время; sessionMinutes — оверрайд длительности.
 */
export class StudySlotInputDto {
  /** Дни недели: 0=воскресенье … 6=суббота. Минимум один. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek!: number[];

  /** Локальное время занятия, "HH:mm" (24h). */
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'timeLocal must be HH:mm' })
  timeLocal!: string;

  /** Оверрайд длительности занятия слота, 10–180 (null/absent → тренировка). */
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(180)
  sessionMinutes?: number | null;
}

/**
 * KS-4927 / ADR-163 §5. Тело POST /study/schedules и
 * PUT /study/schedules/:id. Слоты сохраняются replace-on-write —
 * полный список в каждом запросе.
 */
export class UpsertStudyScheduleDto {
  /** Имя тренировки (ADR-163 §2, до 60 символов). */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  /** IANA-таймзона, например "Europe/Prague". Одна на тренировку. */
  @IsString()
  timezone!: string;

  /** Бюджет занятия в минутах (ADR-160 §2.2), 10–180. */
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(180)
  sessionMinutes?: number;

  @IsOptional()
  @IsIn(STUDY_FOCUS_VALUES)
  focus?: StudyFocus | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Временные диапазоны, 1..7 (ADR-163 §2). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SLOTS_PER_SCHEDULE)
  @ValidateNested({ each: true })
  @Type(() => StudySlotInputDto)
  slots!: StudySlotInputDto[];
}
