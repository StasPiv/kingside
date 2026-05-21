/**
 * Helpers и class-validator декораторы для `GameStepPayloadDto`
 * (KS-3180 / ADR-072 §7 B1, ослаблено в KS-3185).
 *
 * Правила (валидация ВХОДНОГО payload'а — draft-friendly):
 *  1. `type === 'game'`.
 *  2. `sourceType ∈ {'pgn', 'workshop_analysis'}`.
 *  3. `sourceType === 'pgn'`:
 *      * `pgn` опционален (черновик без ходов допустим — KS-3185).
 *      * Если `pgn` задан непустой строкой — должен парситься
 *        chess.js#loadPgn (NB: НЕ требуем «≥ 1 хода» — placeholder `*`
 *        или PGN без ходов тоже валиден, это draft-flow).
 *      * `analysisId` ЗАПРЕЩЁН (структурная ошибка sourceType).
 *  4. `sourceType === 'workshop_analysis'`:
 *      * `analysisId` опционален (draft до выбора анализа — KS-3185).
 *      * Если задан — должен быть UUID.
 *      * `pgn` опционален; сервер перезапишет snapshot'ом из Analysis.
 *  5. PGN ≤ 200 КБ (Byte-length от UTF-8) — для любого sourceType.
 *
 * Жёсткая валидация «PGN с ходами + analysisId резолвится» поедет
 * отдельным gate'ом при ПУБЛИКАЦИИ курса (см. KS-3185 §3 — отдельный
 * тикет; на момент создания/редактирования шаг-черновик допустим).
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
 * Чистая проверка PGN партии (draft-friendly, KS-3185):
 *   - пустая строка / только пробелы → `ok=false, reason='empty'`
 *     (но `IsGamePgn` декоратор трактует empty как «не задано» и
 *     пропускает — XOR с sourceType отдельный);
 *   - размер ≤ MAX_GAME_PGN_BYTES (иначе `too_large`);
 *   - chess.js#loadPgn парсит без исключения (иначе `parse_error`).
 *
 * `no_moves` НЕ проверяется — placeholder `*` или PGN без ходов
 * валидны как draft. Проверка «партия с ходами» — gate публикации
 * курса, не валидация шага-черновика.
 */
export interface GamePgnCheck {
  ok: boolean;
  /** Конкретная причина отказа, если `ok=false`. */
  reason?: 'empty' | 'too_large' | 'parse_error';
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
  // KS-3185: НЕ требуем `history().length > 0` — placeholder `*` / PGN
  // без ходов допустимы (draft-flow редактора шага). Гейт «партия с
  // ходами» переедет на публикацию курса отдельным тикетом.
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
    // KS-3185: pgn опционален (draft). Если задан непустой — парсим.
    if (hasPgn) {
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
    // KS-3185: analysisId опционален (draft до выбора анализа).
    if (hasAnalysisId && !isUuid(payload.analysisId)) {
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
 * `@IsGamePgn()` — поле `pgn` должно парситься chess.js (если задано
 * непустой строкой) и быть ≤ 200 КБ. Пустое/отсутствующее значение —
 * валидно (draft-flow, KS-3185). Требование «есть ходы» снято;
 * placeholder `*` тоже проходит.
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
          if (value === undefined || value === null) return true;
          if (typeof value === 'string' && value.trim().length === 0) return true;
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
            default:
              return `${args.property} must be a string`;
          }
        },
      },
    });
  };
}

/**
 * `@IsGameStepConsistent()` — class-level структурная проверка
 * sourceType ↔ pgn/analysisId. KS-3185: ослаблена под draft-flow.
 *
 *  - sourceType='pgn': analysisId ЗАПРЕЩЁН (структурная несовместимость).
 *    Пустой / отсутствующий pgn — допустим (черновик, KS-3185).
 *  - sourceType='workshop_analysis': pgn опционален (snapshot перезатрёт
 *    его при наличии analysisId). analysisId опционален, но если задан —
 *    UUID (формат проверяет @IsUUID на поле; здесь проверяем тип строки).
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
          const hasAnalysisId =
            typeof o.analysisId === 'string' && (o.analysisId as string).length > 0;
          if (o.sourceType === 'pgn') {
            // Единственное жёсткое требование на этапе draft —
            // structural mismatch: analysisId не должен присутствовать
            // при sourceType=pgn.
            return !hasAnalysisId;
          }
          if (o.sourceType === 'workshop_analysis') {
            // KS-3185: analysisId опционален (draft до выбора анализа).
            // Если задан — формат UUID проверит @IsUUID на поле.
            return true;
          }
          return false; // unknown sourceType — пусть @IsIn отдельно лажу разрулит.
        },
        defaultMessage(args: ValidationArguments) {
          const o = args.object as {
            sourceType?: unknown;
          };
          if (o.sourceType === 'pgn') {
            return `GameStepPayload(sourceType='pgn') must not include analysisId`;
          }
          if (o.sourceType === 'workshop_analysis') {
            return `GameStepPayload(sourceType='workshop_analysis') has inconsistent fields`;
          }
          return `GameStepPayload.sourceType must be 'pgn' or 'workshop_analysis'`;
        },
      },
    });
  };
}
