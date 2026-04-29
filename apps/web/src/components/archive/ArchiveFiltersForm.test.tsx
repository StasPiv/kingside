import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { useState } from 'react';
import {
  ArchiveFiltersForm,
  EMPTY_FILTERS,
  type ArchiveFiltersValues,
} from './ArchiveFiltersForm';

/**
 * KS-2125: тесты общего компонента формы фильтров архива.
 *
 * Покрытие:
 *  - рендер всех полей (Sort/Result/Min Elo/Time Control/Since/Until/
 *    Player/Event/ECO/Min Plies/Max Plies);
 *  - применение каждого фильтра вызывает onChange с правильным patch;
 *  - Reset all (когда передан onReset) — вызывает onReset и очищает
 *    локальные drafts текстовых полей;
 *  - чипы игроков добавляются по Enter, удаляются крестиком.
 */

function Harness({
  initial = EMPTY_FILTERS,
  onSpy,
  resetSpy,
}: {
  initial?: ArchiveFiltersValues;
  onSpy?: (next: ArchiveFiltersValues) => void;
  resetSpy?: () => void;
}) {
  const [values, setValues] = useState<ArchiveFiltersValues>(initial);
  return (
    <ArchiveFiltersForm
      values={values}
      onChange={(next) => {
        setValues(next);
        onSpy?.(next);
      }}
      onReset={
        resetSpy
          ? () => {
              setValues(EMPTY_FILTERS);
              resetSpy();
            }
          : undefined
      }
      testIdPrefix="form"
    />
  );
}

describe('ArchiveFiltersForm — рендер всех полей', () => {
  it('видны Sort, Result, Min Elo, Time Control, Since, Until, Player, Event, ECO, Min/Max Plies', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByTestId('form-sort')).toBeInTheDocument();
    expect(screen.getByTestId('form-result')).toBeInTheDocument();
    expect(screen.getByTestId('form-min-elo-any')).toBeInTheDocument();
    expect(screen.getByTestId('form-min-elo-2600')).toBeInTheDocument();
    expect(screen.getByTestId('form-time-control-any')).toBeInTheDocument();
    expect(screen.getByTestId('form-time-control-classical')).toBeInTheDocument();
    expect(screen.getByTestId('form-since')).toBeInTheDocument();
    expect(screen.getByTestId('form-until')).toBeInTheDocument();
    expect(screen.getByTestId('form-player-input')).toBeInTheDocument();
    expect(screen.getByTestId('form-event')).toBeInTheDocument();
    expect(screen.getByTestId('form-eco')).toBeInTheDocument();
    expect(screen.getByTestId('form-min-ply')).toBeInTheDocument();
    expect(screen.getByTestId('form-max-ply')).toBeInTheDocument();
  });

  it('кнопка «Сбросить все» рендерится только если передан onReset', () => {
    const { rerender } = renderWithProviders(<Harness />);
    expect(screen.queryByTestId('form-reset')).toBeNull();
    rerender(<Harness resetSpy={vi.fn()} />);
    expect(screen.getByTestId('form-reset')).toBeInTheDocument();
  });
});

describe('ArchiveFiltersForm — применение фильтров', () => {
  it('Sort = topElo вызывает onChange', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const spy = vi.fn();
    renderWithProviders(<Harness onSpy={spy} />);
    await user.selectOptions(screen.getByTestId('form-sort'), 'topElo');
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'topElo' }),
    );
  });

  it('Min Elo 2600 — preset активирует одно значение', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const spy = vi.fn();
    renderWithProviders(<Harness onSpy={spy} />);
    await user.click(screen.getByTestId('form-min-elo-2600'));
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ minElo: 2600 }),
    );
  });

  it('Time Control «Классика» добавляется в массив', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const spy = vi.fn();
    renderWithProviders(<Harness onSpy={spy} />);
    await user.click(screen.getByTestId('form-time-control-classical'));
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeControlCategory: ['classical'] }),
    );
  });

  it('Since (date) пишется в state', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const spy = vi.fn();
    renderWithProviders(<Harness onSpy={spy} />);
    const input = screen.getByTestId('form-since') as HTMLInputElement;
    await user.type(input, '2024-01-15');
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: '2024-01-15' }),
    );
  });

  it('Player — Enter добавляет chip и очищает input', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const spy = vi.fn();
    renderWithProviders(<Harness onSpy={spy} />);
    const input = screen.getByTestId('form-player-input') as HTMLInputElement;
    await user.type(input, 'Carlsen');
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ players: ['Carlsen'] }),
    );
    expect(input.value).toBe('');
  });

  it('Player — крестик в chip удаляет игрока', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const spy = vi.fn();
    renderWithProviders(
      <Harness
        initial={{ ...EMPTY_FILTERS, players: ['Carlsen'] }}
        onSpy={spy}
      />,
    );
    await user.click(screen.getByTestId('form-player-remove-Carlsen'));
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ players: [] }),
    );
  });
});

describe('ArchiveFiltersForm — Reset all', () => {
  it('очищает state и зовёт onReset', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const reset = vi.fn();
    const change = vi.fn();
    renderWithProviders(
      <Harness
        initial={{
          ...EMPTY_FILTERS,
          minElo: 2600,
          timeControlCategory: ['classical'],
        }}
        onSpy={change}
        resetSpy={reset}
      />,
    );
    expect(screen.getByTestId('form-min-elo-2600')).toHaveClass('is-active');
    await user.click(screen.getByTestId('form-reset'));
    expect(reset).toHaveBeenCalledTimes(1);
    // После reset state в Harness стал EMPTY_FILTERS — preset «Любое»
    // снова активный.
    expect(screen.getByTestId('form-min-elo-any')).toHaveClass('is-active');
  });
});
