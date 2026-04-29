import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArchiveFiltersForm,
  EMPTY_FILTERS,
  type ArchiveFiltersValues,
} from './ArchiveFiltersForm';

/**
 * KS-2125: форма поиска на лобби `/archive`. После унификации
 * (KS-2125) — тонкая обёртка над общим `ArchiveFiltersForm` с
 * autoNavigate-семантикой:
 *
 *   • любое изменение фильтра, когда state ≠ EMPTY_FILTERS, →
 *     `navigate('/archive/games?<query>')`. Пользователь сразу
 *     попадает на список с применённым фильтром (живое применение).
 *   • Reset → setState(EMPTY) и `navigate('/archive')`, лобби
 *     остаётся видимым (Recent games + by-position CTA).
 *
 * URL-сериализация дублирует `metadataFiltersToUrl` (см.
 * `ArchiveGamesPage`) — каждый player и timeControlCategory кладётся
 * через `append`, остальное через `set`. Прежние form-state поля
 * `sinceYear`/`untilYear` в KS-2125 отменены — на лобби, как и в
 * списке, теперь обычные ISO-даты.
 */

function buildSearchUrl(values: ArchiveFiltersValues): string {
  const params = new URLSearchParams();
  // KS-2084: каждый игрок — отдельный `?player=...`. См.
  // metadataFiltersToUrl в ArchiveGamesPage — единая семантика.
  for (const p of values.players) {
    const trimmed = p.trim();
    if (trimmed.length > 0) params.append('player', trimmed);
  }
  if (values.event) params.set('event', values.event);
  if (values.eco) params.set('eco', values.eco);
  if (values.since) params.set('since', values.since);
  if (values.until) params.set('until', values.until);
  if (values.result !== 'any') params.set('result', values.result);
  if (values.minElo !== null) params.set('minElo', String(values.minElo));
  if (values.minPly !== null) params.set('minPly', String(values.minPly));
  if (values.maxPly !== null) params.set('maxPly', String(values.maxPly));
  if (values.sort !== 'recent') params.set('sort', values.sort);
  for (const cat of values.timeControlCategory) {
    params.append('timeControlCategory', cat);
  }
  const qs = params.toString();
  return qs ? `/archive/games?${qs}` : '/archive/games';
}

/**
 * Считает фильтры «непустыми», то есть отличающимися от EMPTY_FILTERS,
 * чтобы понять, нужно ли уходить на список.
 */
function hasAnyFilter(values: ArchiveFiltersValues): boolean {
  return (
    values.players.length > 0 ||
    values.event !== '' ||
    values.eco !== '' ||
    values.since !== '' ||
    values.until !== '' ||
    values.result !== 'any' ||
    values.minElo !== null ||
    values.minPly !== null ||
    values.maxPly !== null ||
    values.sort !== 'recent' ||
    values.timeControlCategory.length > 0
  );
}

export function ArchiveSearchForm() {
  const navigate = useNavigate();
  const [values, setValues] = useState<ArchiveFiltersValues>(EMPTY_FILTERS);

  const handleChange = (next: ArchiveFiltersValues) => {
    setValues(next);
    if (hasAnyFilter(next)) {
      navigate(buildSearchUrl(next));
    }
  };

  const handleReset = () => {
    setValues(EMPTY_FILTERS);
    navigate('/archive');
  };

  return (
    <div className="archive-lobby__search-form">
      <ArchiveFiltersForm
        values={values}
        onChange={handleChange}
        onReset={handleReset}
        testIdPrefix="archive-search-form"
      />
    </div>
  );
}

// Экспортируем хелпер для unit-тестов URL-сборки.
export { buildSearchUrl as __buildSearchUrl };
