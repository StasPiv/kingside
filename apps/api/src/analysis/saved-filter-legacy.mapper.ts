/**
 * KS-2924 / KS-2929 Phase A5. Legacy mapper для старого
 * REST-контракта `GET/POST/PATCH /analyses/filters`.
 *
 * До KS-2924 saved_filters была одной таблицей с плоскими колонками
 * (`category`, `tags` CSV-строка, `search`, `sort_order`). Frontend
 * Мастерской до фазы B3 продолжает слать/принимать эти поля.
 *
 * Чтобы не дублировать бизнес-логику, новые методы контроллера
 * делегируют в `SavedFiltersService` (Phase A3) — а маппинг
 * legacy-формы ↔ канонической `SavedFilterParams.workshop` живёт
 * здесь.
 *
 * После переезда фронта на новый `/api/user/saved-filters` (Phase B3)
 * этот mapper, legacy-DTO и proxy-эндпоинты будут удалены
 * целиком (Sunset см. контроллер).
 */

import type {
  CreateSavedFilterPayload as SharedCreatePayload,
  SavedFilterDto,
  UpdateSavedFilterPayload as SharedUpdatePayload,
} from '@kingside/shared';
import type { CreateSavedFilterDto as LegacyCreateDto } from './dto/create-saved-filter.dto';
import type { UpdateSavedFilterDto as LegacyUpdateDto } from './dto/update-saved-filter.dto';

/** Форма, которую отдавал старый эндпоинт фронту. */
export interface LegacySavedFilterShape {
  id: string;
  userId: string;
  name: string;
  category: string | null;
  tags: string | null;
  search: string | null;
  sortOrder: string | null;
  createdAt: string;
}

/**
 * SavedFilterDto (Phase A3) → плоский legacy-формат.
 *
 * tags: string[] (params) сериализуется в CSV. Пустой массив или
 * отсутствие → `null` (legacy фронт ожидает либо строку, либо null,
 * не пустую строку).
 */
export function toLegacyShape(
  userId: string,
  dto: SavedFilterDto,
): LegacySavedFilterShape {
  if (dto.params.section !== 'workshop') {
    // По plan'у через legacy-эндпоинт ходят только workshop-фильтры;
    // защита от случайной утечки archive в старый контракт.
    throw new Error(
      `Legacy /analyses/filters не поддерживает section=${dto.params.section}`,
    );
  }
  const p = dto.params;
  return {
    id: dto.id,
    userId,
    name: dto.name,
    category: nullOrString(p.category),
    tags: serializeTags(p.tags),
    search: nullOrString(p.search),
    sortOrder: nullOrString(p.sortOrder),
    createdAt: dto.createdAt,
  };
}

/**
 * Legacy create-body → CreateSavedFilterDto (Phase A3).
 *
 * Пустые строки в плоских полях интерпретируются как «не задано»
 * (NULL/[]) — повторяет старое поведение `SavedFilterService.create`
 * (`category || null`).
 */
export function legacyCreateToShared(
  body: LegacyCreateDto,
): SharedCreatePayload {
  return {
    section: 'workshop',
    name: body.name,
    params: {
      section: 'workshop',
      category: emptyToNull(body.category),
      tags: parseTags(body.tags),
      search: emptyToNull(body.search),
      sortOrder: emptyToNull(body.sortOrder),
    },
  };
}

/**
 * Legacy update-body → UpdateSavedFilterDto.
 *
 * Особенность: если плоское поле передано (даже пустое) — мы должны
 * перезаписать соответствующее поле params. Поскольку legacy update
 * передавался как «частичный плоский patch», без знания текущего
 * params нельзя корректно сформировать новый params. Решение:
 *   - если хотя бы одно из плоских полей задано → собираем новый
 *     params (отсутствующие плоские поля трактуются как `null` / `[]`).
 *     Это совпадает с прежним поведением старого
 *     `SavedFilterService.update`, которое тоже игнорировало
 *     «частичность» (записывало `value || null`).
 *   - если ни одно не задано — params не отправляем (только name).
 *
 * Альтернатива «прочитать текущее, замержить» сложнее и не нужна:
 * legacy frontend всегда шлёт полное состояние всех плоских полей.
 */
export function legacyUpdateToShared(
  body: LegacyUpdateDto,
): SharedUpdatePayload {
  const out: SharedUpdatePayload = {};
  if (body.name !== undefined) {
    out.name = body.name;
  }
  const hasPlainPatch =
    body.category !== undefined ||
    body.tags !== undefined ||
    body.search !== undefined ||
    body.sortOrder !== undefined;
  if (hasPlainPatch) {
    out.params = {
      section: 'workshop',
      category: emptyToNull(body.category),
      tags: parseTags(body.tags),
      search: emptyToNull(body.search),
      sortOrder: emptyToNull(body.sortOrder),
    };
  }
  return out;
}

function nullOrString(v: string | null | undefined): string | null {
  return v == null || v === '' ? null : v;
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v;
  return t === '' ? null : t;
}

function serializeTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return tags.join(',');
}

function parseTags(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return [];
  // CSV без trim — повторяет историческое поведение (старое API
  // хранило строку как есть). Пустые элементы отбрасываются.
  return raw
    .split(',')
    .map((s) => s)
    .filter((s) => s.length > 0);
}
