/**
 * KS-2249 (ADR-035 §11 / E6) — валидаторы для `DrillStepPayload`
 * (`LessonStep.kind = 'drill'`).
 *
 * Pure-функция `validateDrillStepPayload` используется и seed-линтером
 * (`apps/api/src/lessons/seed/lint.ts`), и class-validator декораторами в
 * `step-payload.dto.ts`. Один словарь ошибок — один источник правды,
 * чтобы пред-сид-проверка и рантайм-валидация API совпадали.
 *
 * Правила:
 *   1. `drillType` ∈ TacticDrillType (8 значений из shared).
 *   2. `drillId` (опц.) — UUID v1..v5 (Postgres-подобный). Если задан —
 *      `difficultyBucket` игнорируется backend'ом, но сам по себе
 *      допустим (валидатор не считает это ошибкой — даём редактору
 *      возможность хранить «дефолтный bucket» для случая когда автор
 *      потом снимет привязку к конкретному drillId).
 *   3. `difficultyBucket` (опц.) — 'easy' | 'medium' | 'hard'.
 *   4. `count` (опц.) — целое 1..10.
 *   5. `minSolved` (опц.) — целое 1..count (если count не задан, то 1..10).
 */

import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import type {
  DrillDifficultyBucket,
  TacticDrillType,
} from '@kingside/shared';

const ALLOWED_DRILL_TYPES = new Set<TacticDrillType>([
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
  'count-attackers',
  'find-all-checks',
  'find-undefended-attack',
]);

const ALLOWED_BUCKETS = new Set<DrillDifficultyBucket>(['easy', 'medium', 'hard']);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_COUNT = 10;

export interface DrillValidationResult {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Проверить весь `DrillStepPayload`. Собирает все нарушения сразу
 * (не short-circuit), чтобы линтер показывал полную раскладку за один
 * прогон.
 */
export function validateDrillStepPayload(
  payload: Record<string, unknown>,
  rootPath = '',
): DrillValidationResult {
  const errors: DrillValidationResult['errors'] = [];
  const q = (k: string) => (rootPath ? `${rootPath}.${k}` : k);

  if (payload.type !== 'drill') {
    errors.push({ path: q('type'), message: 'type must be "drill"' });
  }

  const drillType = payload.drillType;
  if (typeof drillType !== 'string' || !ALLOWED_DRILL_TYPES.has(drillType as TacticDrillType)) {
    errors.push({
      path: q('drillType'),
      message:
        'drillType must be one of: ' +
        Array.from(ALLOWED_DRILL_TYPES).join(' | '),
    });
  }

  if (payload.drillId !== undefined) {
    const did = payload.drillId;
    if (typeof did !== 'string' || !UUID_REGEX.test(did)) {
      errors.push({
        path: q('drillId'),
        message: 'drillId must be a valid UUID (or omitted)',
      });
    }
  }

  if (payload.difficultyBucket !== undefined) {
    const b = payload.difficultyBucket;
    if (
      typeof b !== 'string' ||
      !ALLOWED_BUCKETS.has(b as DrillDifficultyBucket)
    ) {
      errors.push({
        path: q('difficultyBucket'),
        message: 'difficultyBucket must be one of: easy | medium | hard',
      });
    }
  }

  let count: number | undefined;
  if (payload.count !== undefined) {
    const c = payload.count;
    if (
      typeof c !== 'number' ||
      !Number.isInteger(c) ||
      c < 1 ||
      c > MAX_COUNT
    ) {
      errors.push({
        path: q('count'),
        message: `count must be an integer in [1, ${MAX_COUNT}] (or omitted)`,
      });
    } else {
      count = c;
    }
  }

  if (payload.minSolved !== undefined) {
    const ms = payload.minSolved;
    const upper = count ?? MAX_COUNT;
    if (
      typeof ms !== 'number' ||
      !Number.isInteger(ms) ||
      ms < 1 ||
      ms > upper
    ) {
      errors.push({
        path: q('minSolved'),
        message:
          count !== undefined
            ? `minSolved must be an integer in [1, ${count}] (count of step)`
            : `minSolved must be an integer in [1, ${MAX_COUNT}] (or omitted)`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── class-validator decorators ──────────────────────────────────────

/**
 * `@IsDrillStepPayload()` — проверяет весь объект-payload через
 * `validateDrillStepPayload`. Применяется к самому DTO-классу через
 * helper-обёртку (используется через discriminator в `step-payload.dto.ts`).
 *
 * На практике class-validator валидирует поля по отдельности через
 * `@IsIn` / `@IsUUID` / `@IsInt`, но эта функция нужна для seed-lint и
 * для cross-field правил (`minSolved ≤ count`).
 */
export function IsValidDrillStepPayload(
  options?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isValidDrillStepPayload',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          return validateDrillStepPayload(
            (args.object as unknown) as Record<string, unknown>,
          ).ok;
        },
        defaultMessage(args: ValidationArguments) {
          const res = validateDrillStepPayload(
            (args.object as unknown) as Record<string, unknown>,
          );
          return (
            res.errors.map((e) => `${e.path}: ${e.message}`).join('; ') ||
            `${args.property} is not a valid DrillStepPayload`
          );
        },
      },
    });
  };
}
