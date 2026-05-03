/**
 * KS-2230. DTO для discriminated-union `AnswerData` (api-contract §3).
 *
 * class-validator не имеет нативной поддержки tagged union'ов; мы
 * валидируем «синтаксис» (regex клеток, диапазон number, форма move) на
 * уровне one-flat DTO + проверка валидности через
 * `validateAnswerData()` ниже. Глубокую сверку с эталоном делает
 * `TacticDrillValidatorService` (api-contract §4).
 *
 * KS-2250-fix-attempt: liberal acceptance. Канонический контракт
 * (`@kingside/shared#AnswerData`) использует разные поля по shape
 * (`square` / `squares` / `value` / `from-to`). Frontend (на момент
 * фикса) шлёт универсальное поле `value` для всех shape:
 *   - `{shape:'square', value:'d6'}`     ← вместо `square:'d6'`
 *   - `{shape:'squares', value:['d6','f6']}`
 *   - `{shape:'move', value:'e2e4'}`     ← UCI-строка
 *   - `{shape:'number', value:2}`        ← правильно
 * Тип `value` в DTO — `unknown` (без декораторов IsInt/Max/etc),
 * валидация по конкретному shape — в `normalizeAnswerData()`. Поля
 * `square`/`squares`/`from-to` оставлены для канонической формы.
 */

import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { AnswerData, AnswerShape, Square } from '@kingside/shared';

const SQUARE_RE = /^[a-h][1-8]$/;

export class AnswerDataDto {
  @IsIn(['square', 'squares', 'number', 'move'])
  shape!: AnswerShape;

  // shape === 'square' (канонический формат).
  @IsOptional()
  @IsString()
  @Matches(SQUARE_RE)
  square?: Square;

  // shape === 'squares' (канонический формат).
  @IsOptional()
  @IsString({ each: true })
  squares?: Square[];

  /**
   * Универсальное поле от frontend'а (alias к `square`/`squares`/`from-to`/
   * `number`-value). Тип `unknown` — валидация в `normalizeAnswerData`
   * по конкретному shape. НЕ ставить @IsInt/@Max — иначе блокируется
   * shape='square' с строкой клетки в `value`.
   */
  @IsOptional()
  value?: unknown;

  // shape === 'move' (канонический формат).
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
 * Валидация дискриминированной формы. Принимает обе формы:
 *  - канон: `square:'d6'` / `squares:['d6']` / `from+to` / `value:N`
 *  - liberal: `value:'d6'` / `value:['d6','f6']` / `value:'e2e4'` /
 *    `value:N`
 * Возвращает узкий тип `AnswerData` или сообщение об ошибке.
 */
export function normalizeAnswerData(
  raw: AnswerDataDto,
): { ok: true; value: AnswerData } | { ok: false; error: string } {
  switch (raw.shape) {
    case 'square': {
      const sq = typeof raw.square === 'string'
        ? raw.square
        : (typeof raw.value === 'string' ? raw.value : null);
      if (!sq || !SQUARE_RE.test(sq)) {
        return { ok: false, error: 'square (or value) [a-h][1-8] required for shape=square' };
      }
      return { ok: true, value: { shape: 'square', square: sq } };
    }
    case 'squares': {
      const arr = Array.isArray(raw.squares)
        ? raw.squares
        : (Array.isArray(raw.value) ? (raw.value as unknown[]) : null);
      if (!arr || arr.length === 0) {
        return { ok: false, error: 'squares[] (or value as array) required for shape=squares' };
      }
      const set = new Set<string>();
      for (const item of arr) {
        if (typeof item !== 'string' || !SQUARE_RE.test(item)) {
          return { ok: false, error: `invalid square in array: ${String(item)}` };
        }
        set.add(item.toLowerCase());
      }
      return {
        ok: true,
        value: { shape: 'squares', squares: Array.from(set) },
      };
    }
    case 'number': {
      const n = typeof raw.value === 'number' ? raw.value : null;
      if (n === null || !Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 4) {
        return { ok: false, error: 'value 1..4 (integer) required for shape=number' };
      }
      return { ok: true, value: { shape: 'number', value: n } };
    }
    case 'move': {
      // Канон: from + to + (опц.) promotion.
      let from: string | null = null;
      let to: string | null = null;
      let promotion: 'q' | 'r' | 'b' | 'n' | null = null;
      if (raw.from && raw.to) {
        from = raw.from;
        to = raw.to;
        promotion = raw.promotion ?? null;
      } else if (typeof raw.value === 'string' && raw.value.length >= 4) {
        // Liberal: UCI-строка `e2e4` или `e7e8q`.
        from = raw.value.slice(0, 2);
        to = raw.value.slice(2, 4);
        const p = raw.value.slice(4, 5);
        if (p === 'q' || p === 'r' || p === 'b' || p === 'n') promotion = p;
      }
      if (!from || !to || !SQUARE_RE.test(from) || !SQUARE_RE.test(to)) {
        return { ok: false, error: 'from/to (or UCI-string in value) required for shape=move' };
      }
      return {
        ok: true,
        value: {
          shape: 'move',
          from,
          to,
          ...(promotion ? { promotion } : {}),
        },
      };
    }
    default:
      return { ok: false, error: `unknown shape: ${(raw as { shape: string }).shape}` };
  }
}

/**
 * KS-2246-fix: нормализация эталона из `tactic_drills.answer` JSONB в
 * канонический `AnswerData`. Чтения этой колонки в БД могут содержать
 * liberal-формат (от chess-expert author-files KS-2246):
 *  - `{shape:'square', value:'<sq>'}` (вместо `square:'<sq>'`)
 *  - `{shape:'squares[]', value:[...]}` (с `[]` в shape)
 *  - `{shape:'move', value:'<UCI>'}` (UCI-string в `value`)
 *  - `{shape:'number', value:N}` (правильно)
 *
 * Возвращает канон или null, если данные сломаны (controller тогда
 * отдаст 500 с понятным сообщением). Whitespace в shape игнорируется,
 * `squares[]` → `squares`.
 *
 * Используется в `recordAttempt` (validator требует канон) и в seed
 * `/tmp/import-curated.mjs` (бэкфилл при upsert).
 */
export function normalizeStoredAnswer(raw: unknown): AnswerData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Strip `[]` от author-format `squares[]` → `squares`.
  const shape = typeof r.shape === 'string' ? r.shape.replace(/\[\]$/, '') : '';

  switch (shape) {
    case 'square': {
      const sq = typeof r.square === 'string'
        ? r.square
        : (typeof r.value === 'string' ? r.value : null);
      if (!sq || !SQUARE_RE.test(sq)) return null;
      return { shape: 'square', square: sq };
    }
    case 'squares': {
      const arr = Array.isArray(r.squares)
        ? r.squares
        : (Array.isArray(r.value) ? (r.value as unknown[]) : null);
      if (!arr || arr.length === 0) return null;
      const set = new Set<string>();
      for (const item of arr) {
        if (typeof item !== 'string' || !SQUARE_RE.test(item)) return null;
        set.add(item.toLowerCase());
      }
      return { shape: 'squares', squares: Array.from(set) };
    }
    case 'number': {
      const n = typeof r.value === 'number' ? r.value : null;
      if (n === null || !Number.isFinite(n) || !Number.isInteger(n)) return null;
      return { shape: 'number', value: n };
    }
    case 'move': {
      let from: string | null = null;
      let to: string | null = null;
      let promotion: 'q' | 'r' | 'b' | 'n' | null = null;
      if (typeof r.from === 'string' && typeof r.to === 'string') {
        from = r.from;
        to = r.to;
        if (r.promotion === 'q' || r.promotion === 'r' || r.promotion === 'b' || r.promotion === 'n') {
          promotion = r.promotion;
        }
      } else if (typeof r.value === 'string' && r.value.length >= 4) {
        from = r.value.slice(0, 2);
        to = r.value.slice(2, 4);
        const p = r.value.slice(4, 5);
        if (p === 'q' || p === 'r' || p === 'b' || p === 'n') promotion = p;
      }
      if (!from || !to || !SQUARE_RE.test(from) || !SQUARE_RE.test(to)) return null;
      return {
        shape: 'move',
        from,
        to,
        ...(promotion ? { promotion } : {}),
      };
    }
    default:
      return null;
  }
}
