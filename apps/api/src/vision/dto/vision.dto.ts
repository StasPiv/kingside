/**
 * KS-4982 / ADR-167 §5: DTO эндпоинтов Vision-тренажёра.
 *
 * Тело `POST /vision/results` — итог одной Sprint-сессии. Валидация
 * «санитарная» (диапазоны, whitelist mode/timeMode): лидерборд
 * тренировочного класса, серверный анти-чит осознанно отложен (ADR §5.2).
 */
import {
  IsIn,
  IsInt,
  IsNumber,
  Max,
  Min,
} from 'class-validator';
import {
  VISION_MODES,
  VISION_TIME_MODES,
  type VisionMode,
  type VisionTimeMode,
} from '@kingside/shared';

export class SubmitVisionResultDto {
  @IsIn(VISION_MODES as unknown as string[])
  mode!: VisionMode;

  @IsIn(VISION_TIME_MODES as unknown as string[])
  timeMode!: VisionTimeMode;

  @IsInt()
  @Min(1)
  @Max(100)
  difficulty!: number;

  @IsInt()
  @Min(0)
  @Max(100000)
  score!: number;

  @IsInt()
  @Min(0)
  @Max(100000)
  total!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  accuracy!: number;

  @IsInt()
  @Min(0)
  @Max(100000)
  maxStreak!: number;

  @IsInt()
  @Min(0)
  @Max(3600000)
  avgResponseMs!: number;
}
