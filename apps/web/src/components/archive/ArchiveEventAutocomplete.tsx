import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { archiveApi } from '../../api/archive';
import {
  ArchiveAutocomplete,
  type ArchiveAutocompleteItem,
} from './ArchiveAutocomplete';

/**
 * KS-2067 (F1): autocomplete по турнирам/событиям архива. Аналог
 * `ArchivePlayerAutocomplete`, отличие — loader (`searchArchiveEvents`)
 * и форматирование meta-метки (диапазон годов вместо gamesCount).
 */

interface ArchiveEventAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (selection: { name: string; slug: string }) => void;
  testIdPrefix?: string;
}

const LIMIT = 10;

function yearOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})/.exec(iso);
  return m ? m[1] : null;
}

export function ArchiveEventAutocomplete({
  value,
  onChange,
  onSelect,
  testIdPrefix = 'archive-event-autocomplete',
}: ArchiveEventAutocompleteProps) {
  const { t } = useTranslation('archive');

  const loader = useCallback(
    async (q: string): Promise<ArchiveAutocompleteItem[]> => {
      const res = await archiveApi.searchArchiveEvents(q, LIMIT);
      return res.items.map((ev) => {
        const firstYear = yearOf(ev.firstDate);
        const lastYear = yearOf(ev.lastDate);
        let years: string | null = null;
        if (firstYear && lastYear) {
          years = firstYear === lastYear ? firstYear : `${firstYear}–${lastYear}`;
        } else if (firstYear || lastYear) {
          years = firstYear ?? lastYear;
        }
        const gamesPart = t('lobby.autocomplete.eventGames', {
          defaultValue: '{{count}} games',
          count: ev.gamesCount,
        });
        return {
          id: ev.slug,
          label: ev.name,
          meta: years ? `${years} · ${gamesPart}` : gamesPart,
        };
      });
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
      placeholder={t('lobby.form.eventPlaceholder', 'Tournament name…')}
      label={t('lobby.form.eventLabel', 'Event')}
      testIdPrefix={testIdPrefix}
    />
  );
}
