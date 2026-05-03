/**
 * Helpers и class-validator декораторы для `GameReviewStepPayloadDto`
 * (L-30 / KS-1811). Те же функции использует seed-линтер
 * (`apps/api/src/lessons/seed/lint.ts`), чтобы рантайм-валидация API и
 * pre-seed-проверка репортили одинаковые ошибки.
 *
 * Правила (согласованы с координатором):
 *  1. `type === 'game_review'`.
 *  2. Ровно одно из `gameId` (UUID) или `pgn` (непустая строка) — XOR.
 *     Пустой payload запрещён, оба заданных поля — тоже ошибка.
 *  3. Если `pgn` задан — он должен парситься `chess.js#loadPgn`.
 *     Пустая строка считается «не задан».
 */

import { Chess } from 'chess.js';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { normalizeNagOrder } from './pgn-normalize';

/** UUID v1..v5 по RFC 4122 (без NIL и без максимальной версии). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Чистая проверка UUID — используется и в DTO-декораторе, и в линтере. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Чистая проверка PGN: `chess.js#loadPgn` не бросает И партия содержит
 * ≥ 1 ход. Пустая строка / только заголовки без ходов — считаем невалидным.
 */
export function isValidPgn(pgn: unknown): pgn is string {
  if (typeof pgn !== 'string' || pgn.trim().length === 0) return false;
  // KS-2280 (ADR-037 R6): нормализуем reverse-order `{comment} $N` →
  // `$N {comment}`, иначе chess.js падает на втором варианте.
  const normalized = normalizeNagOrder(pgn);
  const chess = new Chess();
  try {
    chess.loadPgn(normalized);
  } catch {
    return false;
  }
  return chess.history().length > 0;
}

/**
 * Итоговая проверка game_review payload'а целиком — собирает все
 * нарушения разом (а не short-circuit), чтобы линтер показывал всю
 * раскладку за один прогон.
 */
export interface GameReviewValidationResult {
  ok: boolean;
  errors: string[];
}
export function validateGameReviewPayload(payload: {
  gameId?: unknown;
  pgn?: unknown;
}): GameReviewValidationResult {
  const errors: string[] = [];
  const hasGameId = typeof payload.gameId === 'string' && payload.gameId.length > 0;
  const hasPgn = typeof payload.pgn === 'string' && (payload.pgn as string).length > 0;

  if (!hasGameId && !hasPgn) {
    errors.push('GameReviewStepPayload must specify exactly one of gameId (UUID) or pgn (non-empty string); none provided');
  } else if (hasGameId && hasPgn) {
    errors.push('GameReviewStepPayload must specify exactly one of gameId or pgn; both provided');
  }

  if (hasGameId && !isUuid(payload.gameId)) {
    errors.push('gameId must be a UUID');
  }
  if (hasPgn && !isValidPgn(payload.pgn)) {
    errors.push('pgn must be a valid PGN (parseable by chess.js with at least one move)');
  }

  return { ok: errors.length === 0, errors };
}

// ─── class-validator decorators ──────────────────────────────────────

/** `@IsValidPgn()` — поле `pgn` должно парситься chess.js (если задано). */
export function IsValidPgn(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isValidPgn',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown) {
          // Если значения нет — пусть решает `@IsOptional()` (ниже).
          if (value === undefined || value === null) return true;
          return isValidPgn(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid PGN parseable by chess.js (and contain at least one move)`;
        },
      },
    });
  };
}

/**
 * `@IsGameReviewXor()` — class-level проверка: ровно одно из `gameId` / `pgn`
 * должно быть заполнено. Вешаем на поле `type` (оно есть всегда) —
 * сообщение об ошибке будет на `type.isGameReviewXor`, что ловится
 * одним и тем же selector'ом в линтере / тестах.
 */
export function IsGameReviewXor(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isGameReviewXor',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const o = args.object as { gameId?: unknown; pgn?: unknown };
          const hasGameId = typeof o.gameId === 'string' && (o.gameId as string).length > 0;
          const hasPgn = typeof o.pgn === 'string' && (o.pgn as string).length > 0;
          return (hasGameId ? 1 : 0) + (hasPgn ? 1 : 0) === 1;
        },
        defaultMessage() {
          return 'GameReviewStepPayload must specify exactly one of gameId (UUID) or pgn (non-empty string)';
        },
      },
    });
  };
}
