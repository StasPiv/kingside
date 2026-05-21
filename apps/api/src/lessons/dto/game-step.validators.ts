/**
 * Helpers и class-validator декораторы для `GameStepPayloadDto`
 * (KS-3180 / ADR-072 §7 B1).
 *
 * Правила:
 *  1. `type === 'game'`.
 *  2. `sourceType ∈ {'pgn', 'workshop_analysis'}`.
 *  3. `sourceType === 'pgn'` → `pgn` обязателен (непустая строка,
 *     парсится chess.js#loadPgn с ≥ 1 ходом), `analysisId` ЗАПРЕЩЁН.
 *  4. `sourceType === 'workshop_analysis'` → `analysisId` обязателен
 *     (UUID). `pgn` принимаем опционально; сервер всё равно перезапишет
 *     snapshot'ом из Analysis (см. `GameStepHydratorService`).
 *  5. PGN ≤ 200 КБ (Byte-length от UTF-8).
 *
 * Те же предикаты переиспользуются как в class-validator
 * декораторах, так и в seed-линтере (если шаг 'game' появится в
 * seed-фикстурах позже).
 */

import { Chess } from 'chess.js';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { normalizeNagOrder } from './pgn-normalize';

/** KS-3180. Лимит размера PGN в payload'е шага «Партия» (200 КБ UTF-8). */
export const MAX_GAME_PGN_BYTES = 200 * 1024;

/** UUID v1..v5 — RFC 4122 (тот же regex, что и в `game-review-step.validators`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Проверка UUID. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Размер строки в байтах UTF-8 (через TextEncoder для точности). */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Чистая проверка PGN партии: непустая строка, размер ≤ MAX_GAME_PGN_BYTES,
 * chess.js#loadPgn парсит и в основной линии ≥ 1 ход.
 *
 * Возвращает структурированный результат, чтобы декоратор смог положить
 * конкретную причину в сообщение валидации (size vs parse).
 */
export interface GamePgnCheck {
  ok: boolean;
  /** Конкретная причина отказа, если `ok=false`. */
  reason?: 'empty' | 'too_large' | 'parse_error' | 'no_moves';
}

export function checkGamePgn(pgn: unknown): GamePgnCheck {
  if (typeof pgn !== 'string' || pgn.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (utf8ByteLength(pgn) > MAX_GAME_PGN_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  // KS-2280 (ADR-037 R6): тот же reverse-NAG-fix, что использует
  // GameReviewStep — chess.js падает на `{comment} $N`-порядке.
  const normalized = normalizeNagOrder(pgn);
  const chess = new Chess();
  try {
    chess.loadPgn(normalized);
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
  if (chess.history().length === 0) {
    return { ok: false, reason: 'no_moves' };
  }
  return { ok: true };
}

/** Сводный валидатор всего payload'а (для seed-линтера / тестов). */
export interface GameStepValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateGameStepPayload(payload: {
  sourceType?: unknown;
  pgn?: unknown;
  analysisId?: unknown;
}): GameStepValidationResult {
  const errors: string[] = [];
  const sourceType = payload.sourceType;
  const hasPgn = typeof payload.pgn === 'string' && (payload.pgn as string).length > 0;
  const hasAnalysisId =
    typeof payload.analysisId === 'string' && (payload.analysisId as string).length > 0;

  if (sourceType !== 'pgn' && sourceType !== 'workshop_analysis') {
    errors.push(
      `sourceType must be 'pgn' or 'workshop_analysis' (got: ${JSON.stringify(sourceType)})`,
    );
  }

  if (sourceType === 'pgn') {
    if (!hasPgn) {
      errors.push(`sourceType='pgn' requires pgn field`);
    } else {
      const res = checkGamePgn(payload.pgn);
      if (!res.ok) {
        errors.push(`pgn invalid: ${res.reason}`);
      }
    }
    if (hasAnalysisId) {
      errors.push(`sourceType='pgn' must not include analysisId`);
    }
  }

  if (sourceType === 'workshop_analysis') {
    if (!hasAnalysisId) {
      errors.push(`sourceType='workshop_analysis' requires analysisId field`);
    } else if (!isUuid(payload.analysisId)) {
      errors.push(`analysisId must be a UUID`);
    }
    // pgn для workshop_analysis опционален: сервер перезапишет snapshot'ом.
    // Если клиент всё же прислал pgn, валидируем размер (но не парсинг —
    // его всё равно подменим). Это защита от заведомо большого payload'а.
    if (hasPgn && utf8ByteLength(payload.pgn as string) > MAX_GAME_PGN_BYTES) {
      errors.push(`pgn exceeds ${MAX_GAME_PGN_BYTES} bytes`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── class-validator decorators ──────────────────────────────────────

/**
 * `@IsGamePgn()` — поле `pgn` должно парситься chess.js и быть ≤ 200 КБ.
 * Если значения нет (undefined/null/пустая строка) — пропускаем; XOR
 * с sourceType закрывает class-level декоратор `@IsGameStepConsistent()`.
 */
export function IsGamePgn(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isGamePgn',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null || value === '') return true;
          return checkGamePgn(value).ok;
        },
        defaultMessage(args: ValidationArguments) {
          const value = args.value;
          const res = checkGamePgn(value);
          switch (res.reason) {
            case 'too_large':
              return `${args.property} exceeds ${MAX_GAME_PGN_BYTES} bytes (200 КБ)`;
            case 'parse_error':
              return `${args.property} must be valid PGN parseable by chess.js`;
            case 'no_moves':
              return `${args.property} must contain at least one move`;
            default:
              return `${args.property} must be a non-empty string`;
          }
        },
      },
    });
  };
}

/**
 * `@IsGameStepConsistent()` — class-level XOR для sourceType ↔ pgn/analysisId.
 *
 *  - sourceType='pgn' → pgn обязателен, analysisId запрещён.
 *  - sourceType='workshop_analysis' → analysisId обязателен (UUID),
 *    pgn опционален (snapshot подставит сервер).
 *
 * Вешаем на поле `type` (есть всегда), чтобы validation-error был
 * детерминированным и ловился одним selector'ом в тестах.
 */
export function IsGameStepConsistent(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isGameStepConsistent',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const o = args.object as {
            sourceType?: unknown;
            pgn?: unknown;
            analysisId?: unknown;
          };
          const hasPgn = typeof o.pgn === 'string' && (o.pgn as string).length > 0;
          const hasAnalysisId =
            typeof o.analysisId === 'string' && (o.analysisId as string).length > 0;
          if (o.sourceType === 'pgn') {
            return hasPgn && !hasAnalysisId;
          }
          if (o.sourceType === 'workshop_analysis') {
            return hasAnalysisId && isUuid(o.analysisId);
            // hasPgn — допустим, перезапишем snapshot'ом.
          }
          return false; // unknown sourceType — пусть @IsIn отдельно лажу разрулит.
        },
        defaultMessage(args: ValidationArguments) {
          const o = args.object as {
            sourceType?: unknown;
            pgn?: unknown;
            analysisId?: unknown;
          };
          if (o.sourceType === 'pgn') {
            return `GameStepPayload(sourceType='pgn') requires non-empty pgn and no analysisId`;
          }
          if (o.sourceType === 'workshop_analysis') {
            return `GameStepPayload(sourceType='workshop_analysis') requires analysisId (UUID)`;
          }
          return `GameStepPayload.sourceType must be 'pgn' or 'workshop_analysis'`;
        },
      },
    });
  };
}
