import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { archiveApi } from '../../api/archive';
import {
  ArchiveAutocomplete,
  type ArchiveAutocompleteItem,
} from './ArchiveAutocomplete';

/**
 * KS-2067 (F1): autocomplete по игрокам архива.
 *
 * Внутри использует общий `<ArchiveAutocomplete>`. Loader зовёт
 * `archiveApi.searchArchivePlayers(q, 10)`. Бэкенд (B3) уже отдаёт
 * результаты, ранжированные по `gamesCount` DESC, поэтому никакой
 * клиентской сортировки не требуется.
 */

interface ArchivePlayerAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  /** Колбэк выбора — приходит строка `name` игрока (которую и пишем в URL). */
  onSelect?: (selection: { name: string; slug: string }) => void;
  testIdPrefix?: string;
}

const LIMIT = 10;

export function ArchivePlayerAutocomplete({
  value,
  onChange,
  onSelect,
  testIdPrefix = 'archive-player-autocomplete',
}: ArchivePlayerAutocompleteProps) {
  const { t } = useTranslation('archive');

  const loader = useCallback(
    async (q: string): Promise<ArchiveAutocompleteItem[]> => {
      const res = await archiveApi.searchArchivePlayers(q, LIMIT);
      return res.items.map((p) => ({
        id: p.slug,
        label: p.name,
        meta: t('lobby.autocomplete.playerMeta', {
          defaultValue: '{{count}} games',
          count: p.gamesCount,
        }),
      }));
    },
    [t],
  );

  const handleSelect = useCallback(
    (item: ArchiveAutocompleteItem) => {
      onChange(item.label);
      onSelect?.({ name: item.label, slug: item.id });
    },
    [onChange, onSelect],
  );

  return (
    <ArchiveAutocomplete
      value={value}
      onChange={onChange}
      onSelect={handleSelect}
      loader={loader}
      placeholder={t('lobby.form.playerPlaceholder', 'Player name…')}
      label={t('lobby.form.playerLabel', 'Player')}
      testIdPrefix={testIdPrefix}
    />
  );
}
