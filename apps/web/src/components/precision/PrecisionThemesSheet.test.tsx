import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionThemesSheet } from './PrecisionThemesSheet';

/**
 * KS-3361 (ADR-080 §7 F1). Тесты bottom-sheet'а выбора тем.
 *
 * Покрытие:
 *  - open=false → не рендерится.
 *  - 6 секций (collapsible), tactics развёрнута по умолчанию.
 *  - чекбоксы checked-state из props.
 *  - тема с count=0 → disabled (нельзя ткнуть).
 *  - tap по чекбоксу меняет черновик; Применить → onApply(...).
 *  - Сбросить → onApply([]) + onClose.
 *  - бэкдроп/Esc/× закрывают без apply.
 *  - count в заголовке (precision-themes-sheet-count) когда draft > 0.
 */

const renderSheet = (opts: {
  open?: boolean;
  selected?: string[];
  counts?: Record<string, number> | null;
  onApply?: (t: string[]) => void;
  onClose?: () => void;
}) => {
  const onApply = opts.onApply ?? vi.fn();
  const onClose = opts.onClose ?? vi.fn();
  return {
    onApply,
    onClose,
    ...renderWithProviders(
      <PrecisionThemesSheet
        open={opts.open ?? true}
        onClose={onClose}
        selectedThemes={opts.selected ?? []}
        onApply={onApply}
        themeCounts={opts.counts ?? null}
      />,
    ),
  };
};

beforeEach(() => {
  // No-op: компонент без сетевых вызовов.
});

describe('<PrecisionThemesSheet> KS-3361', () => {
  it('open=false → не рендерится', () => {
    renderSheet({ open: false });
    expect(screen.queryByTestId('precision-themes-sheet')).toBeNull();
  });

  it('рендерит 6 секций', () => {
    renderSheet({});
    for (const k of [
      'tactics',
      'mates',
      'endgame',
      'phase',
      'advantage',
      'misc',
    ]) {
      expect(
        screen.getByTestId(`precision-themes-sheet-group-${k}`),
      ).toBeTruthy();
    }
  });

  it('tactics развёрнута по умолчанию, остальные свернуты', () => {
    renderSheet({});
    // tactics — checkbox pin виден.
    expect(
      screen.queryByTestId('precision-themes-sheet-checkbox-pin'),
    ).toBeTruthy();
    // mates — mateIn1 НЕ виден (свёрнута).
    expect(
      screen.queryByTestId('precision-themes-sheet-checkbox-mateIn1'),
    ).toBeNull();
  });

  it('клик по toggle секции разворачивает её', () => {
    renderSheet({});
    fireEvent.click(
      screen.getByTestId('precision-themes-sheet-group-toggle-mates'),
    );
    expect(
      screen.getByTestId('precision-themes-sheet-checkbox-mateIn1'),
    ).toBeTruthy();
  });

  it('selectedThemes из props → checkbox initially checked', () => {
    renderSheet({ selected: ['pin', 'fork'] });
    const pin = screen.getByTestId(
      'precision-themes-sheet-checkbox-pin',
    ) as HTMLInputElement;
    const fork = screen.getByTestId(
      'precision-themes-sheet-checkbox-fork',
    ) as HTMLInputElement;
    const skewer = screen.getByTestId(
      'precision-themes-sheet-checkbox-skewer',
    ) as HTMLInputElement;
    expect(pin.checked).toBe(true);
    expect(fork.checked).toBe(true);
    expect(skewer.checked).toBe(false);
  });

  it('count=0 → checkbox disabled, item имеет --disabled', () => {
    renderSheet({ counts: { pin: 0, fork: 5 } });
    const pin = screen.getByTestId(
      'precision-themes-sheet-checkbox-pin',
    ) as HTMLInputElement;
    const fork = screen.getByTestId(
      'precision-themes-sheet-checkbox-fork',
    ) as HTMLInputElement;
    expect(pin.disabled).toBe(true);
    expect(fork.disabled).toBe(false);
    expect(
      screen
        .getByTestId('precision-themes-sheet-item-pin')
        .getAttribute('data-disabled'),
    ).toBe('true');
  });

  it('тогглинг чекбокса меняет draft, Применить → onApply', () => {
    const onApply = vi.fn();
    renderSheet({ counts: { pin: 5, fork: 3 }, onApply });
    fireEvent.click(
      screen.getByTestId('precision-themes-sheet-checkbox-pin'),
    );
    fireEvent.click(
      screen.getByTestId('precision-themes-sheet-checkbox-fork'),
    );
    // Счётчик в заголовке (2) — рендерится при draft > 0.
    expect(
      screen.getByTestId('precision-themes-sheet-count').textContent,
    ).toContain('2');
    fireEvent.click(screen.getByTestId('precision-themes-sheet-apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual(['pin', 'fork']);
  });

  it('Сбросить → onApply([])', () => {
    const onApply = vi.fn();
    renderSheet({ selected: ['pin'], onApply });
    fireEvent.click(screen.getByTestId('precision-themes-sheet-reset'));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual([]);
  });

  it('Сбросить disabled когда нет выбранных и draft пуст', () => {
    renderSheet({});
    expect(
      (screen.getByTestId('precision-themes-sheet-reset') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('backdrop click → onClose без apply', () => {
    const onClose = vi.fn();
    const onApply = vi.fn();
    renderSheet({ onClose, onApply });
    fireEvent.click(
      screen.getByTestId('precision-themes-sheet-backdrop'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('× click → onClose без apply', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });
    fireEvent.click(screen.getByTestId('precision-themes-sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
