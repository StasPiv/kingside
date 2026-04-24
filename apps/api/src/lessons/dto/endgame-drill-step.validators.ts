/**
 * Helpers + class-validator декораторы для `EndgameDrillStepPayloadDto`
 * (L-24 / KS-1815). Логика вынесена из декораторов в чистые функции,
 * чтобы тот же словарь ошибок использовался и seed-линтером
 * (`apps/api/src/lessons/seed/lint.ts`), и рантайм-валидацией API.
 *
 * Правила:
 *   1. `fen` — валидный FEN по `chess.js` (переиспользуем `isValidFen`
 *      из `position-step.validators`).
 *   2. `playerSide` ∈ {'white', 'black'}.
 *   3. `skillLevel` — целое 0..20 (UCI Skill Level).
 *   4. `winCondition` — дискриминированный union по `kind`:
 *        - `mate` / `promote` — других полей нет, лишние → ошибка.
 *        - `reach_position` — обязателен валидный `fen` (chess.js).
 *        - `material_advantage` — обязателен целый `amount ≥ 1`.
 *   5. `maxMoves` (опц.) — целое ≥ 1.
 *   6. `hintsAllowed` (опц.) — boolean.
 */

import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isValidFen } from './position-step.validators';

// ─── Pure validators (используются и линтером, и декораторами) ───────

const ALLOWED_WIN_KINDS = new Set<string>([
  'mate',
  'promote',
  'reach_position',
  'material_advantage',
]);

export interface EndgameValidationResult {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Проверить одно значение `winCondition`. `path` — префикс для сообщений
 * (линтер кладёт туда путь до шага, например `slug/lesson/step/payload`).
 */
export function validateEndgameWinCondition(
  wc: unknown,
  path = 'winCondition',
): EndgameValidationResult {
  const errors: EndgameValidationResult['errors'] = [];
  if (!wc || typeof wc !== 'object') {
    errors.push({ path, message: 'winCondition must be an object' });
    return { ok: false, errors };
  }
  const obj = wc as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== 'string' || !ALLOWED_WIN_KINDS.has(kind)) {
    errors.push({
      path: `${path}.kind`,
      message: `winCondition.kind must be one of: mate | promote | reach_position | material_advantage`,
    });
    return { ok: false, errors };
  }

  const allowedKeys: Record<string, readonly string[]> = {
    mate: ['kind'],
    promote: ['kind'],
    reach_position: ['kind', 'fen'],
    material_advantage: ['kind', 'amount'],
  };
  const keys = Object.keys(obj);
  const extras = keys.filter((k) => !allowedKeys[kind].includes(k));
  for (const extra of extras) {
    errors.push({
      path: `${path}.${extra}`,
      message: `winCondition kind="${kind}" does not allow field "${extra}"`,
    });
  }

  if (kind === 'reach_position') {
    if (!('fen' in obj)) {
      errors.push({
        path: `${path}.fen`,
        message: 'winCondition.kind="reach_position" requires fen',
      });
    } else if (!isValidFen(obj.fen)) {
      errors.push({
        path: `${path}.fen`,
        message: 'winCondition.fen is not a valid FEN (chess.js refused to load it)',
      });
    }
  }
  if (kind === 'material_advantage') {
    if (!('amount' in obj)) {
      errors.push({
        path: `${path}.amount`,
        message: 'winCondition.kind="material_advantage" requires amount',
      });
    } else {
      const amount = obj.amount;
      if (
        typeof amount !== 'number' ||
        !Number.isInteger(amount) ||
        amount < 1
      ) {
        errors.push({
          path: `${path}.amount`,
          message: 'winCondition.amount must be an integer ≥ 1',
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Проверить весь `EndgameDrillStepPayload`. Собирает все нарушения
 * сразу (не short-circuit), чтобы линтер показывал полную раскладку
 * за один прогон.
 */
export function validateEndgameDrillPayload(
  payload: Record<string, unknown>,
  rootPath = '',
): EndgameValidationResult {
  const errors: EndgameValidationResult['errors'] = [];
  const q = (k: string) => (rootPath ? `${rootPath}.${k}` : k);

  if (payload.type !== 'endgame_drill') {
    errors.push({ path: q('type'), message: 'type must be "endgame_drill"' });
  }
  if (!isValidFen(payload.fen)) {
    errors.push({
      path: q('fen'),
      message: 'fen is not a valid FEN (chess.js refused to load it)',
    });
  }
  if (payload.playerSide !== 'white' && payload.playerSide !== 'black') {
    errors.push({
      path: q('playerSide'),
      message: 'playerSide must be "white" or "black"',
    });
  }
  const sl = payload.skillLevel;
  if (typeof sl !== 'number' || !Number.isInteger(sl) || sl < 0 || sl > 20) {
    errors.push({
      path: q('skillLevel'),
      message: 'skillLevel must be an integer in [0, 20]',
    });
  }
  const wcRes = validateEndgameWinCondition(payload.winCondition, q('winCondition'));
  errors.push(...wcRes.errors);

  if (payload.maxMoves !== undefined) {
    const mm = payload.maxMoves;
    if (typeof mm !== 'number' || !Number.isInteger(mm) || mm < 1) {
      errors.push({
        path: q('maxMoves'),
        message: 'maxMoves must be an integer ≥ 1 (or omitted)',
      });
    }
  }
  if (payload.hintsAllowed !== undefined && typeof payload.hintsAllowed !== 'boolean') {
    errors.push({
      path: q('hintsAllowed'),
      message: 'hintsAllowed must be a boolean (or omitted)',
    });
  }

  return { ok: errors.length === 0, errors };
}

// ─── class-validator decorators ──────────────────────────────────────

/**
 * `@IsEndgameWinCondition()` — валидирует поле `winCondition` по правилам
 * дискриминированного union (см. `validateEndgameWinCondition`).
 */
export function IsEndgameWinCondition(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isEndgameWinCondition',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown) {
          return validateEndgameWinCondition(value).ok;
        },
        defaultMessage(args: ValidationArguments) {
          const res = validateEndgameWinCondition(args.value);
          return (
            res.errors.map((e) => e.message).join('; ') ||
            `${args.property} is not a valid EndgameWinCondition`
          );
        },
      },
    });
  };
}
