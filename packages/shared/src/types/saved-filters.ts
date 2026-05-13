/**
 * KS-2924 / KS-2928 Phase A4 — контракты сохранённых фильтров.
 *
 * План: `docs/architecture/KS-2924-saved-filters-archive.md` §3.1, §3.2.
 *
 * Источник истины для двух сторон:
 *   - backend (apps/api: модуль saved-filters, KS-2926/2927)
 *   - frontend (apps/web: страницы /workshop, /archive, KS-29xx Phase B)
 *
 * Дискриминатор — `section`. Каждая секция имеет собственный набор полей
 * фильтра (см. {@link SavedFilterParams}). При расширении доменного
 * множества `section` нужно одновременно:
 *   1) расширить тип {@link SavedFilterSection},
 *   2) обновить ветку union'а {@link SavedFilterParams},
 *   3) обновить CHECK `saved_filters_section_check` в БД
 *      (миграция 20260513090000_ks2925_saved_filters_section_params).
 */

import type {
  ArchiveGameResult,
  ArchiveGamesSortMetadata,
} from './archive.js';
import type { ArchiveTimeControlCategory } from '../utils/time-control.js';

/** Секция, к которой относится сохранённый фильтр. Должна
 *  соответствовать CHECK на колонке `saved_filters.section`. */
export type SavedFilterSection = 'workshop' | 'archive';

/**
 * Результат партии в archive-фильтре. К стандартному
 * {@link ArchiveGameResult} добавлено явное значение `'any'` —
 * «любой результат». Используется для хранения снимка состояния UI
 * фильтра в saved-filter, где «любой» — это осознанный выбор
 * пользователя, отличаемый от отсутствия фильтра (`null`) на
 * REST-эндпоинтах архива.
 */
export type ArchiveResult = ArchiveGameResult | 'any';

/**
 * Алиас для сортировки archive-листинга, тождественен
 * {@link ArchiveGamesSortMetadata}. Введён для удобства типизации
 * параметров saved-filter (KS-2928) и единообразия с FE-кодом, где
 * сохранённая сортировка хранится отдельно от sort на endpoint'е.
 */
export type ArchiveSort = ArchiveGamesSortMetadata;

/**
 * Параметры сохранённого фильтра — дискриминированный union по
 * `section`. Каждая ветка перечисляет полный набор полей, релевантных
 * соответствующей странице. Опциональные поля выражены через `null`
 * (а не `undefined`/optional) — для прозрачной сериализации в JSONB
 * и однозначной семантики «фильтр явно сброшен» vs «фильтр не
 * установлен».
 */
export type SavedFilterParams =
  | {
      section: 'workshop';
      category: string | null;
      tags: string[];
      search: string | null;
      sortOrder: string | null;
    }
  | {
      section: 'archive';
      players: string[];
      event: string | null;
      eco: string | null;
      result: ArchiveResult | null;
      minElo: number | null;
      since: string | null;
      until: string | null;
      minPly: number | null;
      maxPly: number | null;
      /** Набор категорий контроля времени. Пустой массив — фильтр не
       *  применён, непустой — OR между значениями. */
      timeControlCategory: ArchiveTimeControlCategory[];
      sort: ArchiveSort | null;
    };

/** REST-представление сохранённого фильтра. */
export interface SavedFilterDto {
  id: string;
  section: SavedFilterSection;
  name: string;
  params: SavedFilterParams;
  /** ISO timestamp (UTC). */
  createdAt: string;
  /** ISO timestamp (UTC). */
  updatedAt: string;
}

/** Payload POST /api/saved-filters. `section` в DTO и в `params`
 *  обязан совпадать — иначе 400 (валидация на бэке). */
export interface CreateSavedFilterPayload {
  section: SavedFilterSection;
  name: string;
  params: SavedFilterParams;
}

/** Payload PATCH /api/saved-filters/:id. Менять `section` фильтра
 *  не разрешено — для смены секции нужно создать новый фильтр и
 *  удалить старый. */
export interface UpdateSavedFilterPayload {
  name?: string;
  params?: SavedFilterParams;
}
