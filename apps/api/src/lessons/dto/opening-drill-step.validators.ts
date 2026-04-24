/**
 * Helpers + class-validator декораторы для `OpeningDrillStepPayloadDto`
 * (L-32 / KS-1816). Логика вынесена из декораторов в чистые функции —
 * чтобы тот же словарь ошибок использовался и seed-линтером
 * (`apps/api/src/lessons/seed/lint.ts`), и рантайм-валидацией API.
 *
 * Правила:
 *   1. `type === 'opening_drill'`.
 *   2. `pgn` — непустая строка, парсится `chess.js#loadPgn` без исключений,
 *      в основной линии ≥ 1 хода. Варианты `(…)` допускаются и проверяются
 *      chess.js'ом на балансировку скобок (несбалансированные → throw).
 *   3. `playerSide` ∈ {'white', 'black'}.
 *   4. `onDeviation` ∈ {'show_correction', 'engine_punish'}.
 *   5. `engineSkillLevel` (опц.) — целое 0..20 (UCI Skill Level).
 */

import { Chess } from 'chess.js';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

export interface OpeningDrillValidationResult {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Чистая проверка PGN для дебютного тренажёра: `chess.js#loadPgn` не
 * бросает И основная линия содержит ≥ 1 ход. Варианты `(…)` допустимы
 * — chess.js парсит основную линию, игнорируя варианты, но бросает при
 * несбалансированных скобках.
 */
export function isValidDrillPgn(pgn: unknown): pgn is string {
  if (typeof pgn !== 'string' || pgn.trim().length === 0) return false;
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    return false;
  }
  return chess.history().length > 0;
}

export function validateOpeningDrillPayload(
  payload: Record<string, unknown>,
  rootPath = '',
): OpeningDrillValidationResult {
  const errors: OpeningDrillValidationResult['errors'] = [];
  const q = (k: string) => (rootPath ? `${rootPath}.${k}` : k);

  if (payload.type !== 'opening_drill') {
    errors.push({ path: q('type'), message: 'type must be "opening_drill"' });
  }
  if (!isValidDrillPgn(payload.pgn)) {
    errors.push({
      path: q('pgn'),
      message:
        'pgn must be a non-empty string parseable by chess.js with at least one move in the main line (variation parentheses must be balanced)',
    });
  }
  if (payload.playerSide !== 'white' && payload.playerSide !== 'black') {
    errors.push({
      path: q('playerSide'),
      message: 'playerSide must be "white" or "black"',
    });
  }
  if (
    payload.onDeviation !== 'show_correction' &&
    payload.onDeviation !== 'engine_punish'
  ) {
    errors.push({
      path: q('onDeviation'),
      message: 'onDeviation must be "show_correction" or "engine_punish"',
    });
  }
  if (payload.engineSkillLevel !== undefined) {
    const sl = payload.engineSkillLevel;
    if (typeof sl !== 'number' || !Number.isInteger(sl) || sl < 0 || sl > 20) {
      errors.push({
        path: q('engineSkillLevel'),
        message: 'engineSkillLevel must be an integer in [0, 20] (or omitted)',
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── class-validator decorators ──────────────────────────────────────

/**
 * `@IsDrillPgn()` — проверяет, что значение — валидный PGN с ≥ 1 ходом
 * в основной линии. Используется DTO; логика — в `isValidDrillPgn`.
 */
export function IsDrillPgn(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isDrillPgn',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown) {
          return isValidDrillPgn(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a non-empty PGN parseable by chess.js with at least one move in the main line`;
        },
      },
    });
  };
}
