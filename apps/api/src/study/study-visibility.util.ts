import { BadRequestException } from '@nestjs/common';
import {
  STUDY_VISIBILITIES,
  StudyVisibility,
} from './study-limits';

/**
 * KS-2856 / ADR-060 §3.2 (KS-2859 B3). Маппинг между legacy `isPublic`
 * и тройным `visibility`. Используется в `StudyService.create/update`
 * чтобы:
 *   - принимать оба поля от фронта (старый и новый Phase 2);
 *   - корректно держать обе колонки в БД синхронно до момента полной
 *     раскатки фронта (потом удалим `is_public` отдельной миграцией).
 *
 * Правила:
 *   - если в DTO указана `visibility` — она в приоритете, `isPublic`
 *     вычисляется как `visibility !== 'private'`.
 *   - если указан только `isPublic` — `visibility = true ? 'public'
 *     : 'private'` (unlisted фронт-MVP не знает).
 *   - если оба указаны — приоритет `visibility`, `isPublic` из DTO
 *     игнорируется.
 *   - если ни одно не указано — undefined (Partial update без
 *     изменения visibility).
 */
export function resolveVisibilityChange(input: {
  visibility?: string;
  isPublic?: boolean;
}): { visibility: StudyVisibility; isPublic: boolean } | null {
  if (input.visibility !== undefined) {
    if (
      !STUDY_VISIBILITIES.includes(input.visibility as StudyVisibility)
    ) {
      throw new BadRequestException(
        `Invalid visibility: ${input.visibility}`,
      );
    }
    const v = input.visibility as StudyVisibility;
    return { visibility: v, isPublic: v !== 'private' };
  }
  if (input.isPublic !== undefined) {
    return {
      visibility: input.isPublic ? 'public' : 'private',
      isPublic: input.isPublic,
    };
  }
  return null;
}

/**
 * Нормализация topics перед записью: trim + lower-case. Пустые
 * элементы отбрасываются. Дедупликация (на случай если фронт
 * пришлёт `['opening', 'Opening']` — оба маппятся в `opening`).
 * Возвращает копию массива, не мутирует input.
 */
export function normalizeTopics(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const set = new Set<string>();
  for (const t of raw) {
    const norm = t.trim().toLowerCase();
    if (norm.length > 0) set.add(norm);
  }
  return Array.from(set);
}
