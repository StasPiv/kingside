/**
 * KS-2230. DTO для discriminated-union `AnswerData` (api-contract §3).
 *
 * class-validator не имеет нативной поддержки tagged union'ов; мы
 * валидируем «синтаксис» (regex клеток, диапазон number, форма move) на
 * уровне one-flat DTO + проверка валидности через
 * `validateAnswerData()` ниже. Глубокую сверку с эталоном делает
 * `TacticDrillValidatorService` (api-contract §4).
 */

import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type { AnswerData, AnswerShape, Square } from '@kingside/shared';

const SQUARE_RE = /^[a-h][1-8]$/;

export class AnswerDataDto {
  @IsIn(['square', 'squares', 'number', 'move'])
  shape!: AnswerShape;

  // shape === 'square'
  @IsOptional()
  @IsString()
  @Matches(SQUARE_RE)
  square?: Square;

  // shape === 'squares'
  @IsOptional()
  @IsString({ each: true })
  squares?: Square[];

  // shape === 'number'
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  value?: number;

  // shape === 'move'
  @IsOptional()
  @IsString()
  @Matches(SQUARE_RE)
  from?: Square;

  @IsOptional()
  @IsString()
  @Matches(SQUARE_RE)
  to?: Square;

  @IsOptional()
  @IsIn(['q', 'r', 'b', 'n'])
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/**
 * Валидация дискриминированной формы (после class-validator
 * поверхностной проверки). Возвращает узкий тип `AnswerData` или
 * сообщение об ошибке.
 */
export function normalizeAnswerData(
  raw: AnswerDataDto,
): { ok: true; value: AnswerData } | { ok: false; error: string } {
  switch (raw.shape) {
    case 'square':
      if (!raw.square || !SQUARE_RE.test(raw.square)) {
        return { ok: false, error: 'square is required for shape=square' };
      }
      return { ok: true, value: { shape: 'square', square: raw.square } };
    case 'squares': {
      if (!Array.isArray(raw.squares) || raw.squares.length === 0) {
        return { ok: false, error: 'squares[] is required for shape=squares' };
      }
      const set = new Set<string>();
      for (const sq of raw.squares) {
        if (!SQUARE_RE.test(sq)) {
          return { ok: false, error: `invalid square: ${sq}` };
        }
        set.add(sq.toLowerCase());
      }
      return {
        ok: true,
        value: { shape: 'squares', squares: Array.from(set) },
      };
    }
    case 'number':
      if (typeof raw.value !== 'number' || raw.value < 1 || raw.value > 4) {
        return { ok: false, error: 'value 1..4 required for shape=number' };
      }
      return { ok: true, value: { shape: 'number', value: raw.value } };
    case 'move':
      if (!raw.from || !raw.to || !SQUARE_RE.test(raw.from) || !SQUARE_RE.test(raw.to)) {
        return { ok: false, error: 'from/to required for shape=move' };
      }
      return {
        ok: true,
        value: {
          shape: 'move',
          from: raw.from,
          to: raw.to,
          ...(raw.promotion ? { promotion: raw.promotion } : {}),
        },
      };
    default:
      return { ok: false, error: `unknown shape: ${(raw as { shape: string }).shape}` };
  }
}
