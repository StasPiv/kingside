import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { GAMEBOOK_LIMITS } from '../study-limits';

/**
 * KS-2856 / ADR-060 §3.3 R4 (KS-2858 B2). Payload автора для главы
 * в режиме `gamebook`:
 *
 *   {
 *     intro?: string,
 *     byUci?: {
 *       "<uci>": { hint?: string, success?: string, failure?: string }
 *     }
 *   }
 *
 * Структура хранится в `StudyChapter.gamebook` (JSONB), валидируется
 * сервисом перед записью. Лимиты — `GAMEBOOK_LIMITS`.
 *
 * `byUci` смоделирован как `Record<string, GamebookNodeDto>` —
 * class-validator не валидирует ключи (по spec), но проверяет
 * структуру значений и общее количество узлов (см. `GamebookPayloadDto`).
 */
export class GamebookNodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(GAMEBOOK_LIMITS.textPerNodeMaxLength)
  hint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(GAMEBOOK_LIMITS.textPerNodeMaxLength)
  success?: string;

  @IsOptional()
  @IsString()
  @MaxLength(GAMEBOOK_LIMITS.textPerNodeMaxLength)
  failure?: string;
}

/**
 * Корневой DTO gamebook payload'а. Количество узлов в `byUci`
 * валидируется в сервисе (B3) — class-validator не поддерживает
 * `Record<...>` напрямую, поэтому сюда мы складываем структуру для
 * `@ValidateNested` через `each: true` на каждый объект-значение
 * перебором ключей в сервисе.
 */
export class GamebookPayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(GAMEBOOK_LIMITS.introMaxLength)
  intro?: string;

  /**
   * `Record<uci, GamebookNodeDto>` хранится в JSONB. Type-преобразование
   * вручную в сервисе (класс-валидатор не валидирует ключи объекта).
   * Валидация: typeof === 'object' && !Array.isArray && все значения
   * валидируются как `GamebookNodeDto`; общее количество ключей ≤
   * `GAMEBOOK_LIMITS.maxNodes`.
   */
  @IsOptional()
  byUci?: Record<string, GamebookNodeDto>;
}

/**
 * Валидация payload'а в сервисе: вызывается перед записью
 * `gamebook` в БД. Бросает BadRequestException при нарушении.
 *
 * Жёсткие проверки (не покрывается class-validator из-за Record-ключей):
 *  - `byUci` — plain object (не массив);
 *  - длина каждого UCI-ключа (4..5 символов, минимальная защита);
 *  - количество узлов ≤ `GAMEBOOK_LIMITS.maxNodes`;
 *  - тип каждого `value` — объект;
 *  - длина `hint`/`success`/`failure` (через те же
 *    `textPerNodeMaxLength`).
 *
 * @throws `Error` — invariant brake; в сервисе обернём в
 *   BadRequestException для корректного HTTP 400 (см. B3).
 */
export function validateGamebookPayload(
  raw: unknown,
): { intro?: string; byUci?: Record<string, GamebookNodeDto> } {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('gamebook must be an object');
  }
  const out: { intro?: string; byUci?: Record<string, GamebookNodeDto> } = {};
  const obj = raw as Record<string, unknown>;

  if (obj.intro !== undefined) {
    if (typeof obj.intro !== 'string') {
      throw new Error('gamebook.intro must be a string');
    }
    if (obj.intro.length > GAMEBOOK_LIMITS.introMaxLength) {
      throw new Error(
        `gamebook.intro too long (max ${GAMEBOOK_LIMITS.introMaxLength})`,
      );
    }
    out.intro = obj.intro;
  }

  if (obj.byUci !== undefined) {
    if (
      obj.byUci === null ||
      typeof obj.byUci !== 'object' ||
      Array.isArray(obj.byUci)
    ) {
      throw new Error('gamebook.byUci must be an object');
    }
    const byUci = obj.byUci as Record<string, unknown>;
    const keys = Object.keys(byUci);
    if (keys.length > GAMEBOOK_LIMITS.maxNodes) {
      throw new Error(
        `gamebook.byUci too many nodes (max ${GAMEBOOK_LIMITS.maxNodes})`,
      );
    }
    const cleanByUci: Record<string, GamebookNodeDto> = {};
    for (const key of keys) {
      // Простая защита: UCI ≈ 4-5 символов (e2e4 / e7e8q). Не парсим
      // сами ходы — фронт отвечает за корректность; здесь только
      // упрощённый sanity-check ключа.
      if (
        typeof key !== 'string' ||
        key.length < 4 ||
        key.length > 5
      ) {
        throw new Error(`gamebook.byUci has invalid uci key: "${key}"`);
      }
      const node = byUci[key];
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        throw new Error(`gamebook.byUci["${key}"] must be an object`);
      }
      const n = node as Record<string, unknown>;
      const cleanNode: GamebookNodeDto = {};
      for (const field of ['hint', 'success', 'failure'] as const) {
        const v = n[field];
        if (v === undefined) continue;
        if (typeof v !== 'string') {
          throw new Error(
            `gamebook.byUci["${key}"].${field} must be a string`,
          );
        }
        if (v.length > GAMEBOOK_LIMITS.textPerNodeMaxLength) {
          throw new Error(
            `gamebook.byUci["${key}"].${field} too long (max ${GAMEBOOK_LIMITS.textPerNodeMaxLength})`,
          );
        }
        cleanNode[field] = v;
      }
      cleanByUci[key] = cleanNode;
    }
    out.byUci = cleanByUci;
  }

  return out;
}
