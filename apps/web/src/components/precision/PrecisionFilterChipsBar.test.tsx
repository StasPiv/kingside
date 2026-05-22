import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionFilterChipsBar } from './PrecisionFilterChipsBar';

/**
 * KS-3243 (ADR-076 §7 F1): тесты chip-фильтров. Покрытие:
 *  - переключение «Все/Мои» меняет ?mine=true.
 *  - segment «Тип» меняет ?objective=...
 *  - show-solved toggle меняет ?showSolved.
 *  - «+ Рейтинг» pill дёргает onOpenRatingSheet.
 *  - ↺ Reset очищает все фильтры включая ELO.
 *  - testid'ы из desktop-фильтров (precision-tab-all/mine,
 *    precision-objective-{key}, precision-show-solved) переиспользованы.
 */

const authMock: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'u' },
};
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

function ParamsSink({ onParams }: { onParams: (sp: URLSearchParams) => void }) {
  const [sp] = useSearchParams();
  onParams(sp);
  return null;
}

function renderBar(opts: {
  initialUrl?: string;
  ratingLabel?: string | null;
  onOpen?: () => void;
  onParams?: (sp: URLSearchParams) => void;
}) {
  const onOpen = opts.onOpen ?? vi.fn();
  return renderWithProviders(
    <>
      <PrecisionFilterChipsBar
        onOpenRatingSheet={onOpen}
        ratingLabel={opts.ratingLabel ?? null}
      />
      {opts.onParams && <ParamsSink onParams={opts.onParams} />}
    </>,
    { route: opts.initialUrl ?? '/precision' },
  );
}

beforeEach(() => {
  authMock.user = { id: 'u1', username: 'u' };
});

describe('<PrecisionFilterChipsBar> (KS-3243)', () => {
  it('рендерит «Все/Мои» когда есть user, скрывает их у гостя', () => {
    renderBar({});
    expect(screen.queryByTestId('precision-tab-all')).toBeTruthy();
    expect(screen.queryByTestId('precision-tab-mine')).toBeTruthy();
    expect(screen.queryByTestId('precision-show-solved')).toBeTruthy();
  });

  it('гостям «Все/Мои» и show-solved скрыты', () => {
    authMock.user = null;
    renderBar({});
    expect(screen.queryByTestId('precision-tab-all')).toBeNull();
    expect(screen.queryByTestId('precision-tab-mine')).toBeNull();
    expect(screen.queryByTestId('precision-show-solved')).toBeNull();
    // Objectives видны всем.
    expect(screen.queryByTestId('precision-objective-all')).toBeTruthy();
  });

  it('клик «Мои» добавляет mine=true в URL', () => {
    let captured: URLSearchParams | null = null;
    renderBar({ onParams: (sp) => (captured = sp) });
    fireEvent.click(screen.getByTestId('precision-tab-mine'));
    expect(captured?.get('mine')).toBe('true');
  });

  it('клик «Реализуй» добавляет objective=convertAdvantage', () => {
    let captured: URLSearchParams | null = null;
    renderBar({ onParams: (sp) => (captured = sp) });
    fireEvent.click(screen.getByTestId('precision-objective-convertAdvantage'));
    expect(captured?.get('objective')).toBe('convertAdvantage');
  });

  it('«Все» в objective удаляет ?objective= из URL', () => {
    let captured: URLSearchParams | null = null;
    renderBar({
      initialUrl: '/precision?objective=saveEquality',
      onParams: (sp) => (captured = sp),
    });
    fireEvent.click(screen.getByTestId('precision-objective-all'));
    expect(captured?.has('objective')).toBe(false);
  });

  it('toggle show-solved добавляет/убирает ?showSolved=true', () => {
    let captured: URLSearchParams | null = null;
    renderBar({ onParams: (sp) => (captured = sp) });
    const toggle = screen.getByTestId('precision-show-solved');
    fireEvent.click(toggle);
    expect(captured?.get('showSolved')).toBe('true');
    fireEvent.click(toggle);
    expect(captured?.has('showSolved')).toBe(false);
  });

  it('«+ Рейтинг» pill дёргает onOpenRatingSheet', () => {
    const onOpen = vi.fn();
    renderBar({ onOpen });
    fireEvent.click(screen.getByTestId('precision-chips-rating-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('ratingLabel="1600–2200" подсвечивает «+ Рейтинг» pill активным', () => {
    renderBar({ ratingLabel: '1600–2200' });
    const btn = screen.getByTestId('precision-chips-rating-open');
    expect(btn.className).toContain('precision-chip--active');
    expect(btn.textContent).toContain('1600–2200');
  });

  it('Reset показывается только при активных фильтрах и очищает URL', () => {
    // Без фильтров — нет кнопки.
    renderBar({});
    expect(screen.queryByTestId('precision-chips-reset')).toBeNull();

    let captured: URLSearchParams | null = null;
    renderBar({
      initialUrl:
        '/precision?mine=true&objective=convertAdvantage&showSolved=true&blundererEloMin=1600',
      ratingLabel: '1600–3000',
      onParams: (sp) => (captured = sp),
    });
    const reset = screen.getByTestId('precision-chips-reset');
    fireEvent.click(reset);
    expect(captured?.has('mine')).toBe(false);
    expect(captured?.has('objective')).toBe(false);
    expect(captured?.has('showSolved')).toBe(false);
    expect(captured?.has('blundererEloMin')).toBe(false);
    expect(captured?.has('blundererEloMax')).toBe(false);
  });
});
