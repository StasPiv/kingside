/**
 * KS-2125. После унификации формы фильтров (`ArchiveFiltersForm`)
 * этот файл оставлен только для обратной совместимости — внешние
 * импорты типов/значений должны постепенно перейти на
 * `ArchiveFiltersForm`. Сам компонент-обёртка фиксирует
 * `testIdPrefix='archive-metadata-filter'`, чтобы существующие
 * `data-testid`-селекторы на страницах и в тестах продолжали работать.
 */

import {
  ArchiveFiltersForm,
  EMPTY_FILTERS,
  type ArchiveFiltersValues,
} from './ArchiveFiltersForm';

export { TIME_CONTROL_PRESETS } from './ArchiveTimeControlChips';
export type { MetadataResultFilter } from './ArchiveFiltersForm';

/** @deprecated используйте `ArchiveFiltersValues` из `ArchiveFiltersForm`. */
export type ArchiveMetadataFilterValues = ArchiveFiltersValues;

/** @deprecated используйте `EMPTY_FILTERS` из `ArchiveFiltersForm`. */
export const EMPTY_METADATA_FILTERS: ArchiveFiltersValues = EMPTY_FILTERS;

interface ArchiveMetadataFiltersProps {
  values: ArchiveFiltersValues;
  onChange: (next: ArchiveFiltersValues) => void;
  onReset?: () => void;
}

/** @deprecated используйте `ArchiveFiltersForm`. */
export function ArchiveMetadataFilters({
  values,
  onChange,
  onReset,
}: ArchiveMetadataFiltersProps) {
  return (
    <ArchiveFiltersForm
      values={values}
      onChange={onChange}
      onReset={onReset}
      testIdPrefix="archive-metadata-filter"
    />
  );
}
