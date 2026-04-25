/**
 * Валидаторы `CustomPuzzle` (ADR-029, KS-1908).
 *
 * Custom puzzle — авторская задача в шаге `puzzle` пользовательского
 * курса. В отличие от системных puzzle (mode='ids'/'filter'), все
 * данные лежат прямо в payload и должны быть валидированы при
 * сохранении шага. Авторская ошибка (нелегальный ход, битый FEN)
 * иначе доедет до студента и сломает шаг.
 *
 * Алгоритм (см. ADR §3.2):
 *   1. FEN парсится `new Chess(fen)` — иначе 400.
 *   2. `solutionMoves` — массив 0..40 UCI-ходов (KS-1911: пустой
 *      допустим как промежуточный draft автора; runtime-инвариант
 *      «нужен хотя бы 1 ход» проверяется в runner'е, не в DTO).
 *   3. UCI-формат `[a-h][1-8][a-h][1-8][qrbn]?`.
 *   4. **Пошаговая legality**: применяем ходы по очереди от стартового
 *      FEN; на каждый — `chess.move({from,to,promotion})`. Любой
 *      нелегальный → ошибка с индексом хода.
 *   5. `orientation` (опц.) — `'white'|'black'`.
 *   6. `themes` (опц.) — 0..5 строк длиной 1..30.
 *   7. `caption` (опц.) — строка ≤200 символов.
 *
 * Лимиты соответствуют `USER_COURSES_LIMITS.customPuzzlesPerStep` /
 * `customPuzzleSolutionMoves` (см. `user-courses-limits.ts`).
 *
 * Логика вынесена в чистые функции, чтобы тот же словарь ошибок
 * использовался и seed-линтером (если custom puzzle когда-нибудь
 * появится в системных курсах), и рантайм-валидацией API.
 */

import { Chess } from 'chess.js';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isValidFen } from './position-step.validators';
import { USER_COURSES_LIMITS } from '../user-courses/user-courses-limits';

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export interface CustomPuzzleValidationResult {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Проверяет одну `CustomPuzzle`. `pathPrefix` — префикс для путей в
 * сообщениях (например, `customPuzzles[2]`).
 *
 * Возвращает все найденные нарушения (не short-circuit), чтобы автор
 * видел всю картину сразу.
 */
export function validateCustomPuzzle(
  raw: unknown,
  pathPrefix = 'customPuzzle',
): CustomPuzzleValidationResult {
  const errors: CustomPuzzleValidationResult['errors'] = [];
  const q = (k: string) => (pathPrefix ? `${pathPrefix}.${k}` : k);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      path: pathPrefix,
      message: 'customPuzzle must be an object',
    });
    return { ok: false, errors };
  }
  const p = raw as Record<string, unknown>;

  // ─── FEN ────────────────────────────────────────────────────────
  const fen = p.fen;
  if (!isValidFen(fen)) {
    errors.push({
      path: q('fen'),
      message:
        'fen is not a valid FEN (chess.js refused to load it). ' +
        'Expected a position like "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".',
    });
    // Без валидного FEN дальнейшая legality-проверка ходов
    // бессмысленна — chess.js не сможет загрузить позицию.
    // Но shape solutionMoves/orientation/themes/caption проверим.
  }

  // ─── solutionMoves ──────────────────────────────────────────────
  // KS-1911: нижняя граница снята (`0..N`), пустой массив валиден —
  // это промежуточный draft автора. Runtime-проверка «не пускать
  // студента в шаг с 0 ходов» — задача runner'а, не DTO.
  const moves = p.solutionMoves;
  const maxMoves = USER_COURSES_LIMITS.customPuzzleSolutionMoves;
  if (!Array.isArray(moves)) {
    errors.push({
      path: q('solutionMoves'),
      message: 'solutionMoves must be an array of UCI strings',
    });
  } else if (moves.length > maxMoves) {
    errors.push({
      path: q('solutionMoves'),
      message: `solutionMoves must contain at most ${maxMoves} moves (got ${moves.length})`,
    });
  } else {
    // Shape-проверка каждого UCI до пошаговой legality. Если shape
    // битый — пишем ошибку и не запускаем chess.js, иначе
    // chess.move() свалится на парсинге и засветит мусор в логе.
    let shapeOk = true;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (typeof m !== 'string' || !UCI_RE.test(m)) {
        errors.push({
          path: q(`solutionMoves[${i}]`),
          message: `move "${String(m)}" is not a valid UCI (expected "${UCI_RE}")`,
        });
        shapeOk = false;
      }
    }

    if (shapeOk && isValidFen(fen)) {
      // Пошаговое применение. Стопаем на первом нелегальном —
      // ходы после него уже бессмысленно проверять (позиция
      // расходится с реальной игрой). Но ошибки до этого момента
      // (shape) уже сохранены.
      const game = new Chess();
      try {
        game.load(fen as string);
      } catch {
        // isValidFen прошёл, а load бросает — теоретически невозможно,
        // но защищаемся: один error на весь блок.
        errors.push({
          path: q('fen'),
          message: 'fen failed to load into chess.js (race?)',
        });
        return { ok: false, errors };
      }

      for (let i = 0; i < moves.length; i++) {
        const uci = moves[i] as string;
        const move = safeChessMove(game, uci);
        if (!move) {
          errors.push({
            path: q(`solutionMoves[${i}]`),
            message:
              `move ${i + 1} ("${uci}") is illegal in this position. ` +
              `Verify the move against the position after the previous moves.`,
          });
          break;
        }
      }
    }
  }

  // ─── orientation ────────────────────────────────────────────────
  if (p.orientation !== undefined) {
    if (p.orientation !== 'white' && p.orientation !== 'black') {
      errors.push({
        path: q('orientation'),
        message: 'orientation must be "white" or "black" (or omitted)',
      });
    }
  }

  // ─── themes ─────────────────────────────────────────────────────
  if (p.themes !== undefined) {
    const themes = p.themes;
    if (!Array.isArray(themes)) {
      errors.push({
        path: q('themes'),
        message: 'themes must be an array of strings (or omitted)',
      });
    } else if (themes.length > USER_COURSES_LIMITS.customPuzzleThemes) {
      errors.push({
        path: q('themes'),
        message:
          `themes can have at most ${USER_COURSES_LIMITS.customPuzzleThemes} ` +
          `tags (got ${themes.length})`,
      });
    } else {
      for (let i = 0; i < themes.length; i++) {
        const t = themes[i];
        if (typeof t !== 'string') {
          errors.push({
            path: q(`themes[${i}]`),
            message: 'theme tag must be a string',
          });
        } else if (t.length < 1 || t.length > USER_COURSES_LIMITS.customPuzzleThemeLength) {
          errors.push({
            path: q(`themes[${i}]`),
            message:
              `theme tag length must be 1..${USER_COURSES_LIMITS.customPuzzleThemeLength} ` +
              `(got ${t.length})`,
          });
        }
      }
    }
  }

  // ─── caption ────────────────────────────────────────────────────
  if (p.caption !== undefined) {
    if (typeof p.caption !== 'string') {
      errors.push({
        path: q('caption'),
        message: 'caption must be a string (or omitted)',
      });
    } else if (p.caption.length > USER_COURSES_LIMITS.customPuzzleCaptionLength) {
      errors.push({
        path: q('caption'),
        message:
          `caption length must be at most ` +
          `${USER_COURSES_LIMITS.customPuzzleCaptionLength} characters ` +
          `(got ${p.caption.length})`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Проверка массива `customPuzzles` — длина 0..N + delegate в
 * `validateCustomPuzzle` для каждого элемента.
 *
 * KS-1911: нижняя граница снята. Пустой массив валиден — это
 * промежуточный draft автора (autosave при смене mode на 'custom').
 * Runtime-проверка «не пускать студента в шаг с 0 puzzle» — задача
 * runner'а, не DTO.
 */
export function validateCustomPuzzlesArray(
  raw: unknown,
  pathPrefix = 'customPuzzles',
): CustomPuzzleValidationResult {
  const errors: CustomPuzzleValidationResult['errors'] = [];
  const max = USER_COURSES_LIMITS.customPuzzlesPerStep;
  if (!Array.isArray(raw)) {
    errors.push({
      path: pathPrefix,
      message: 'customPuzzles must be an array',
    });
    return { ok: false, errors };
  }
  if (raw.length > max) {
    errors.push({
      path: pathPrefix,
      message: `customPuzzles must contain at most ${max} puzzles (got ${raw.length})`,
    });
    // Не выходим: пусть автор увидит и shape-ошибки тоже.
  }
  for (let i = 0; i < raw.length; i++) {
    const item = validateCustomPuzzle(raw[i], `${pathPrefix}[${i}]`);
    errors.push(...item.errors);
  }
  return { ok: errors.length === 0, errors };
}

function safeChessMove(game: Chess, uci: string) {
  // chess.js@1.x в некоторых сборках бросает SyntaxError на
  // невозможных промоушенах (e.g. e7e8 без promotion при пешке).
  // Заворачиваем — и невалид трактуем как «нелегальный ход», а
  // не как фатал.
  try {
    return game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    });
  } catch {
    return null;
  }
}

// ─── class-validator decorators ──────────────────────────────────────

/**
 * `@IsCustomPuzzle()` — валидирует одиночный `CustomPuzzle`-объект.
 * Используется на полях DTO, где custom puzzle — единичная сущность.
 */
export function IsCustomPuzzle(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isCustomPuzzle',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown) {
          return validateCustomPuzzle(value).ok;
        },
        defaultMessage(args: ValidationArguments) {
          const res = validateCustomPuzzle(args.value);
          return (
            res.errors.map((e) => `${e.path}: ${e.message}`).join('; ') ||
            `${args.property} is not a valid CustomPuzzle`
          );
        },
      },
    });
  };
}

/**
 * `@IsCustomPuzzlesArray()` — валидирует массив `CustomPuzzle[]`
 * (используется в `PuzzleSelectionCustomDto.customPuzzles`).
 */
export function IsCustomPuzzlesArray(
  options?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isCustomPuzzlesArray',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown) {
          return validateCustomPuzzlesArray(value).ok;
        },
        defaultMessage(args: ValidationArguments) {
          const res = validateCustomPuzzlesArray(args.value);
          return (
            res.errors.map((e) => `${e.path}: ${e.message}`).join('; ') ||
            `${args.property} is not a valid CustomPuzzle array`
          );
        },
      },
    });
  };
}
