/**
 * Утилиты и class-validator декораторы для валидации `PositionStepPayload`.
 *
 * Источник истины для shape'а — `@kingside/shared` (`PositionStepPayload`).
 * Здесь реализована доменная проверка: FEN валиден в `chess.js`, каждый
 * UCI-ход легален на позиции. Используется:
 *   - из `PositionStepPayloadDto` (class-validator в рантайме API);
 *   - из seed-линтера (`apps/api/src/lessons/seed/lint.ts`).
 *
 * Обе точки входа должны видеть одинаковый набор ошибок, поэтому хелперы
 * вынесены в отдельный модуль и импортируются как DTO, так и линтером.
 */

import { Chess } from 'chess.js';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Результат доменной валидации.
 * `errors` — список человекочитаемых сообщений; пустой = всё ок.
 */
export interface PositionValidationResult {
  ok: boolean;
  errors: string[];
}

/** Чистая проверка: FEN парсится `chess.js` без исключения. */
export function isValidFen(fen: unknown): fen is string {
  if (typeof fen !== 'string' || fen.trim().length === 0) return false;
  try {
    const chess = new Chess();
    chess.load(fen);
    return true;
  } catch {
    return false;
  }
}

/**
 * Проверить, что `uci` — легальный ход на позиции `fen`.
 *
 * UCI-формат: "e2e4" (обычный), "e7e8q" (промоушен). Для валидации
 * требуется валидный FEN; если FEN битый — вернёт false (детали
 * репортит `isValidFen`).
 */
export function isLegalUciOnFen(fen: string, uci: unknown): boolean {
  if (typeof uci !== 'string') return false;
  // UCI: 4 символа (from+to) либо 5 с буквой промоушена.
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false;

  const chess = new Chess();
  try {
    chess.load(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    const move = chess.move({ from, to, promotion });
    if (!move) return false;
    chess.undo();
    return true;
  } catch {
    return false;
  }
}

/**
 * Проверить целиком payload `PositionStep` — FEN + каждый expectedMoves[i].
 * Возвращает все найденные ошибки разом (не short-circuit), чтобы seed-линтер
 * мог показать всю раскладку за один прогон.
 */
export function validatePositionPayload(payload: {
  fen?: unknown;
  expectedMoves?: unknown;
}): PositionValidationResult {
  const errors: string[] = [];

  if (!isValidFen(payload.fen)) {
    errors.push('fen is not a valid FEN (chess.js refused to load it)');
    // Без валидного FEN проверять ходы бессмысленно.
    return { ok: false, errors };
  }

  if (!Array.isArray(payload.expectedMoves) || payload.expectedMoves.length === 0) {
    errors.push('expectedMoves must be a non-empty array of UCI moves');
    return { ok: errors.length === 0, errors };
  }

  for (const [i, uci] of (payload.expectedMoves as unknown[]).entries()) {
    if (!isLegalUciOnFen(payload.fen as string, uci)) {
      errors.push(`expectedMoves[${i}] ("${String(uci)}") is not a legal UCI move from the given FEN`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── class-validator decorators ──────────────────────────────────────

/**
 * `@IsFen()` — пропускает значение, если `chess.js` грузит его как FEN.
 */
export function IsFen(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isFen',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isValidFen(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid FEN (chess.js failed to load it)`;
        },
      },
    });
  };
}

/**
 * `@ArePositionMovesLegal('fen')` — валидирует массив строк: каждый UCI-ход
 * должен быть легален на позиции из поля `fenProperty` того же объекта.
 * При невалидном FEN сам по себе декоратор НЕ репортит ошибку на поле
 * `expectedMoves` (её поймает `@IsFen` на самом поле `fen`), но помечает
 * массив как невалидный, чтобы не пропустить payload дальше.
 *
 * KS-1983: пустой массив или отсутствующее значение считаются валидными —
 * это режим read-only-позиции (шаг просто показывает диаграмму, без
 * ожидания ходов от ученика). Опциональность поля контролируется
 * `@IsOptional()` на уровне DTO.
 */
export function ArePositionMovesLegal(
  fenProperty: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'arePositionMovesLegal',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [fenProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          // KS-1983: undefined/null/пустой массив = read-only, ОК.
          if (value === undefined || value === null) return true;
          if (!Array.isArray(value)) return false;
          if (value.length === 0) return true;

          const [relatedProp] = args.constraints as [string];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fen = (args.object as any)[relatedProp];
          if (!isValidFen(fen)) {
            // FEN битый — эту ошибку поднимет @IsFen; здесь считаем массив
            // невалидным, чтобы не давать шаг в прод.
            return false;
          }
          for (const uci of value) {
            if (!isLegalUciOnFen(fen, uci)) return false;
          }
          return true;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property}, if provided, must be an array of UCI moves, each legal on the provided FEN`;
        },
      },
    });
  };
}
