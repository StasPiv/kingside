import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { CreateLiveAnalysisDto as CreateLiveAnalysisDtoShape } from '@kingside/shared';

/**
 * KS-3732 / ADR-110 §2.3. Тело `POST /live-analyses`.
 *
 * KS-3758 / KS-3761 / ADR-112 §3: добавлено обязательное поле
 * `analysisId` — UUID `Analysis.id`, к которому привязывается
 * трансляция. Невалидный формат / пустая строка → 400 от
 * `ValidationPipe`. Существование и принадлежность анализа
 * проверяет сервис (404 / 403, KS-3759).
 *
 * `startingFen` валидируется не здесь, а в сервисе через `chess.js` —
 * `class-validator` не умеет в FEN, а пускать regex на 70+ символов
 * с шестью полями (placement, активная сторона, рокировки, en passant,
 * halfmove, fullmove) — заведомо хрупкое решение.
 */
export class CreateLiveAnalysisDto implements CreateLiveAnalysisDtoShape {
  // KS-3761 / ADR-112 §3: обязательный UUID v4. ValidationPipe
  // отбрасывает невалидные значения до сервиса.
  @IsNotEmpty()
  @IsString()
  @IsUUID('4')
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
