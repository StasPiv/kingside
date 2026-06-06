import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { CreateLiveAnalysisDto as CreateLiveAnalysisDtoShape } from '@kingside/shared';

/**
 * KS-3732 / ADR-110 §2.3. Тело `POST /live-analyses`.
 *
 * Все поля опциональны: без них трансляция стартует со стандартной
 * начальной позиции и без заголовка.
 *
 * `startingFen` валидируется не здесь, а в сервисе через `chess.js` —
 * `class-validator` не умеет в FEN, а пускать regex на 70+ символов
 * с шестью полями (placement, активная сторона, рокировки, en passant,
 * halfmove, fullmove) — заведомо хрупкое решение.
 */
export class CreateLiveAnalysisDto implements CreateLiveAnalysisDtoShape {
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
