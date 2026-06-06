import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { CreateLiveAnalysisDto as CreateLiveAnalysisDtoShape } from '@kingside/shared';

/**
 * KS-3732 / ADR-110 §2.3. Тело `POST /live-analyses`.
 *
 * KS-3758 / ADR-112 §3: добавлено обязательное поле `analysisId`
 * (UUID `Analysis.id`). Полная валидация (`@IsUUID('4')`,
 * `@IsNotEmpty()`) подключается отдельной задачей KS-3761; здесь
 * объявление присутствует, чтобы класс соответствовал shared-типу и
 * сборка проходила.
 *
 * `startingFen` валидируется не здесь, а в сервисе через `chess.js` —
 * `class-validator` не умеет в FEN, а пускать regex на 70+ символов
 * с шестью полями (placement, активная сторона, рокировки, en passant,
 * halfmove, fullmove) — заведомо хрупкое решение.
 */
export class CreateLiveAnalysisDto implements CreateLiveAnalysisDtoShape {
  // KS-3758 / KS-3761: тип объявлен, полная валидация — отдельной
  // задачей. Поле обязательное согласно ADR-112 §3.
  @IsString()
  analysisId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  startingFen?: string;

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';
}
