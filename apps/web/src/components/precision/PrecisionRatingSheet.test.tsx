import { describe, it, expect, vi } from 'vitest';
import { fireEvent, act } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PrecisionRatingSheet,
  ratingLabelFromUrl,
} from './PrecisionRatingSheet';

/**
 * KS-3243 (ADR-076 §7 F1): тесты bottom-sheet'а с slider'ом.
 */

function ParamsSink({ onParams }: { onParams: (sp: URLSearchParams) => void }) {
  const [sp] = useSearchParams();
  onParams(sp);
  return null;
}

function renderSheet(opts: {
  open?: boolean;
  initialUrl?: string;
  onClose?: () => void;
  onParams?: (sp: URLSearchParams) => void;
}) {
  const onClose = opts.onClose ?? vi.fn();
  return renderWithProviders(
    <>
      <PrecisionRatingSheet open={opts.open ?? true} onClose={onClose} />
      {opts.onParams && <ParamsSink onParams={opts.onParams} />}
    </>,
    { route: opts.initialUrl ?? '/precision' },
  );
}

describe('<PrecisionRatingSheet> (KS-3243)', () => {
  it('open=false → ничего не рендерится', () => {
    const { container } = renderSheet({ open: false });
    expect(container.querySelector('.precision-rating-sheet')).toBeNull();
  });

  it('open=true → виден slider с min/max инпутами и testid-ами', () => {
    renderSheet({ open: true });
    expect(screen.getByTestId('precision-rating-sheet')).toBeTruthy();
    expect(screen.getByTestId('precision-elo-filter-min')).toBeTruthy();
    expect(screen.getByTestId('precision-elo-filter-max')).toBeTruthy();
  });

  it('Backdrop click → onClose', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });
    fireEvent.click(screen.getByTestId('precision-rating-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('кнопка «Готово» → onClose', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });
    fireEvent.click(screen.getByTestId('precision-rating-sheet-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Изменение min slider → URL обновляется (с debounce 300ms)', () => {
    vi.useFakeTimers();
    let captured: URLSearchParams | null = null;
    renderSheet({
      open: true,
      onParams: (sp) => (captured = sp),
    });
    const min = screen.getByTestId('precision-elo-filter-min') as HTMLInputElement;
    fireEvent.change(min, { target: { value: '1600' } });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(captured?.get('blundererEloMin')).toBe('1600');
    vi.useRealTimers();
  });
});

describe('ratingLabelFromUrl', () => {
  function sp(s: string) {
    return new URLSearchParams(s);
  }
  it('пустой URL → null', () => {
    expect(ratingLabelFromUrl(sp(''))).toBeNull();
  });
  it('крайние значения (800/3000) → null (фильтра нет)', () => {
    expect(
      ratingLabelFromUrl(sp('blundererEloMin=800&blundererEloMax=3000')),
    ).toBeNull();
  });
  it('частичный фильтр (только min) → строка', () => {
    expect(ratingLabelFromUrl(sp('blundererEloMin=1600'))).toBe('1600–3000');
  });
  it('двусторонний фильтр → строка', () => {
    expect(
      ratingLabelFromUrl(sp('blundererEloMin=1600&blundererEloMax=2200')),
    ).toBe('1600–2200');
  });
});
