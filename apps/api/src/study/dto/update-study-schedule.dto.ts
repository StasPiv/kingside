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
  Min,
} from 'class-validator';
import type { StudyFocus } from '@kingside/shared';

/** Допустимые значения focus (ADR-160 §2.4). */
export const STUDY_FOCUS_VALUES: StudyFocus[] = [
  'tactics',
  'openings',
  'endgames',
  'balanced',
];

/**
 * Тело `PUT /study/schedule` (KS-4880 / ADR-160 §3). Upsert:
 * расписание 1:1 с пользователем, повторный PUT перезаписывает.
 *
 * Валидация timezone (IANA) — в сервисе через `Intl.supportedValuesOf`
 * недоступен на всех рантаймах, используем конструктор
 * `Intl.DateTimeFormat` (кидает RangeError на неизвестной зоне).
 */
export class UpdateStudyScheduleDto {
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

  /** IANA-таймзона, например "Europe/Prague". */
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
}
