/**
 * KS-3347 (ADR-079 §2.6). Миграция legacy URL'ов /precision на новый
 * `?scope=server|drafts|published`.
 *
 * Старая схема:
 *   - `?mine=true&visibility=draft` → новый `?scope=drafts`
 *   - `?mine=true&visibility=public` → новый `?scope=published`
 *   - `?mine=true` (без visibility) → новый `?scope=drafts` (default
 *     для «мои» был draft в KS-2586). Backend это значение принимает
 *     как mine=true, visibility=draft.
 *   - `?mine=false` или без `mine` → новый `?scope=server` (default).
 *
 * Используется на mount'е `PrecisionPage` через `setSearchParams({ replace: true })`.
 * Идемпотентно: если `scope` уже в URL — миграция возвращает null.
 */
import type { PrecisionScope } from '@kingside/shared';

/**
 * @returns новый URLSearchParams если требуется миграция, иначе null.
 * Caller вызывает `setSearchParams(result, { replace: true })`.
 */
export function migrateLegacyPrecisionParams(
  searchParams: URLSearchParams,
): URLSearchParams | null {
  // Уже на новой схеме — пропускаем.
  if (searchParams.has('scope')) return null;

  const mineParam = searchParams.get('mine') === 'true';
  const visibilityParam = searchParams.get('visibility');

  // Если ни `mine`, ни `visibility` не заданы — это «чистый» server-scope,
  // не нужно ничего переписывать (мы используем default 'server' при
  // чтении).
  if (!mineParam && !visibilityParam) return null;

  const next = new URLSearchParams(searchParams);
  next.delete('mine');
  next.delete('visibility');

  let scope: PrecisionScope;
  if (mineParam) {
    // mine=true: смотрим на visibility.
    scope = visibilityParam === 'public' ? 'published' : 'drafts';
  } else {
    // mine=false (или просто visibility без mine) — всё равно server.
    scope = 'server';
  }
  next.set('scope', scope);
  return next;
}

/**
 * Считать текущий `scope` из URL. Если параметра нет — default 'server'.
 * `null` user (гость) → forced 'server' (drafts/published скрыты в UI).
 *
 * Backward-compat: если `scope` отсутствует, но в URL есть legacy
 * `?mine&visibility`, выводим scope из них (на случай если миграция
 * useEffect ещё не отработала или setSearchParams не доступен).
 * Это даёт корректное поведение даже на первом фрейме рендера и
 * сохраняет поведение для тестов, замокавших `setSearchParams`.
 */
export function readPrecisionScope(
  searchParams: URLSearchParams,
  isAuthenticated: boolean,
): PrecisionScope {
  if (!isAuthenticated) return 'server';
  const raw = searchParams.get('scope');
  if (raw === 'drafts' || raw === 'published' || raw === 'server') return raw;
  // Backward-compat: legacy URL без миграции.
  const mine = searchParams.get('mine') === 'true';
  if (mine) {
    return searchParams.get('visibility') === 'public' ? 'published' : 'drafts';
  }
  return 'server';
}

/**
 * Маппинг scope → {mine, visibility, excludeMine} для legacy
 * `useInfinitePuzzles` (через `InfinitePuzzleFilters`). Backend
 * `PuzzleRepository.browse` принимает legacy mine/visibility + KS-3353
 * `excludeMine=true` (для scope=server — «не мои публичные»).
 *
 * KS-3353: при scope='server' для авторизованного юзера обязателен
 * `excludeMine=true`. Без него backend применял legacy OR-логику
 * `(created_by=me OR is_public=true)` и в выдачу попадали ЧУЖИЕ
 * черновики (правда нет — там только мои + публичные, но фильтр НЕ
 * исключал свои публичные → пилл «Серверные» включал свои черновики
 * через `is_public=true` OR-фразу). Backend KS-3353 ввёл явный
 * `excludeMine=true` → SQL `is_public=true AND (created_by IS NULL OR
 * created_by != me)`. NULL-aware: legacy-пазлы без `created_by`
 * включаются.
 *
 * Для гостя `excludeMine=true` не нужен — backend для anon уже
 * фолбэчит на `is_public=true` без user-specific логики. Если
 * передать — backend проигнорирует userId-ветку. Чтобы не флудить
 * URL лишним параметром, гостям не возвращаем `excludeMine`.
 */
export function scopeToLegacyFilters(
  scope: PrecisionScope,
  isAuthenticated: boolean,
): {
  mine: boolean | undefined;
  visibility: 'draft' | 'public' | undefined;
  excludeMine?: boolean;
} {
  switch (scope) {
    case 'drafts':
      return { mine: true, visibility: 'draft' };
    case 'published':
      return { mine: true, visibility: 'public' };
    case 'server':
    default:
      // KS-3353: для авторизованного — excludeMine=true, чтобы
      // исключить свои черновики из «Серверные». Для гостя — пусто
      // (backend сам отдаст public-only).
      return isAuthenticated
        ? { mine: undefined, visibility: undefined, excludeMine: true }
        : { mine: undefined, visibility: undefined };
  }
}
