import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
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
}
