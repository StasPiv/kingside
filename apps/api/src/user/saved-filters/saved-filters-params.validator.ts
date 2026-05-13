import { BadRequestException } from '@nestjs/common';
import type {
  ArchiveResult,
  ArchiveSort,
  SavedFilterParams,
  SavedFilterSection,
} from '@kingside/shared';
import type { ArchiveTimeControlCategory } from '@kingside/shared';

/**
 * KS-2924 / KS-2927 Phase A3. Ручная валидация и нормализация
 * `SavedFilterParams` по дискриминатору `section`. Используется
 * из `SavedFiltersService` для всех write-операций (create, update).
 *
 * Принципы:
 *   - strict-mode по дискриминатору (KS-2930 §4.1): любое поле,
 *     не входящее в whitelist текущей секции, → 400. Это защищает
 *     от path-confusion багов фронта (напр. отправка `params.players`
 *     с `section='workshop'`).
 *   - поле `section` внутри params допускается, но обязано совпадать
 *     с `dto.section`; иначе → 400.
 *   - типы полей строго проверяются (string|null, number|null,
 *     enum, массив-enum);
 *   - вместо `undefined` всегда выдаётся `null` или `[]` —
 *     каноническая форма для JSONB.
 *
 * При невалидной форме бросается `BadRequestException` с указанием
 * конкретного поля.
 */

const WORKSHOP_KEYS: ReadonlySet<string> = new Set([
  'section',
  'category',
  'tags',
  'search',
  'sortOrder',
]);

const ARCHIVE_KEYS: ReadonlySet<string> = new Set([
  'section',
  'players',
  'event',
  'eco',
  'result',
  'minElo',
  'since',
  'until',
  'minPly',
  'maxPly',
  'timeControlCategory',
  'sort',
]);

const ARCHIVE_RESULTS: readonly ArchiveResult[] = [
  '1-0',
  '0-1',
  '1/2-1/2',
  '*',
  'any',
];

const ARCHIVE_SORTS: readonly ArchiveSort[] = ['recent', 'topElo', 'oldest'];

const TIME_CONTROL_CATEGORIES: readonly ArchiveTimeControlCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
];

export function normalizeSavedFilterParams(
  section: SavedFilterSection,
  raw: unknown,
): SavedFilterParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('params must be an object');
  }
  const r = raw as Record<string, unknown>;

  const allowed = section === 'workshop' ? WORKSHOP_KEYS : ARCHIVE_KEYS;
  for (const key of Object.keys(r)) {
    if (!allowed.has(key)) {
      throw new BadRequestException(
        `params.${key} is not allowed for section='${section}'`,
      );
    }
  }
  if (typeof r.section === 'string' && r.section !== section) {
    throw new BadRequestException(
      `params.section ('${r.section}') does not match dto.section ('${section}')`,
    );
  }

  if (section === 'workshop') {
    return {
      section: 'workshop',
      category: nullableString(r.category, 'params.category'),
      tags: stringArray(r.tags, 'params.tags'),
      search: nullableString(r.search, 'params.search'),
      sortOrder: nullableString(r.sortOrder, 'params.sortOrder'),
    };
  }

  // section === 'archive'
  return {
    section: 'archive',
    players: stringArray(r.players, 'params.players'),
    event: nullableString(r.event, 'params.event'),
    eco: nullableString(r.eco, 'params.eco'),
    result: nullableEnum(r.result, ARCHIVE_RESULTS, 'params.result'),
    minElo: nullableInteger(r.minElo, 'params.minElo'),
    since: nullableString(r.since, 'params.since'),
    until: nullableString(r.until, 'params.until'),
    minPly: nullableInteger(r.minPly, 'params.minPly'),
    maxPly: nullableInteger(r.maxPly, 'params.maxPly'),
    timeControlCategory: enumArray(
      r.timeControlCategory,
      TIME_CONTROL_CATEGORIES,
      'params.timeControlCategory',
    ),
    sort: nullableEnum(r.sort, ARCHIVE_SORTS, 'params.sort'),
  };
}

/**
 * Возвращает копию params без поля `section` — в БД JSONB-колонка
 * не дублирует дискриминатор, он хранится на колонке
 * `saved_filters.section`. При чтении сервис подмешивает section
 * обратно в DTO.
 */
export function stripSectionFromParams(
  params: SavedFilterParams,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { section: _section, ...rest } = params;
  return rest;
}

function nullableString(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    throw new BadRequestException(`${field} must be a string or null`);
  }
  return v;
}

function stringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new BadRequestException(`${field} must be an array of strings`);
  }
  for (const x of v) {
    if (typeof x !== 'string') {
      throw new BadRequestException(`${field} must contain only strings`);
    }
  }
  return [...(v as string[])];
}

function nullableInteger(v: unknown, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new BadRequestException(`${field} must be a finite number or null`);
  }
  return v;
}

function nullableEnum<T extends string>(
  v: unknown,
  domain: readonly T[],
  field: string,
): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !domain.includes(v as T)) {
    throw new BadRequestException(
      `${field} must be one of [${domain.join(', ')}] or null`,
    );
  }
  return v as T;
}

function enumArray<T extends string>(
  v: unknown,
  domain: readonly T[],
  field: string,
): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new BadRequestException(`${field} must be an array`);
  }
  for (const x of v) {
    if (typeof x !== 'string' || !domain.includes(x as T)) {
      throw new BadRequestException(
        `${field} contains invalid value: ${String(x)}`,
      );
    }
  }
  return [...(v as T[])];
}
