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
 *  - ↺ Reset очищает все фильтры включая legacy ELO-параметры.
 *  - testid'ы из desktop-фильтров (precision-tab-all/mine,
 *    precision-objective-{key}, precision-show-solved) переиспользованы.
 *
 * KS-3664: pill «+ Рейтинг» удалён вместе со слайдером — тесты на
 * onOpenRatingSheet/ratingLabel сняты.
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
  onParams?: (sp: URLSearchParams) => void;
}) {
  return renderWithProviders(
    <>
      <PrecisionFilterChipsBar />
      {opts.onParams && <ParamsSink onParams={opts.onParams} />}
    </>,
    { route: opts.initialUrl ?? '/precision' },
  );
}

beforeEach(() => {
  authMock.user = { id: 'u1', username: 'u' };
});

describe('<PrecisionFilterChipsBar> (KS-3243)', () => {
  it('KS-3347: рендерит 3 scope-pill\'а (server/drafts/published) для авторизованного', () => {
    renderBar({});
    expect(screen.queryByTestId('precision-scope-server')).toBeTruthy();
    expect(screen.queryByTestId('precision-scope-drafts')).toBeTruthy();
    expect(screen.queryByTestId('precision-scope-published')).toBeTruthy();
    expect(screen.queryByTestId('precision-show-solved')).toBeTruthy();
  });

  it('KS-3347: гостю виден только scope=server (drafts/published скрыты)', () => {
    authMock.user = null;
    renderBar({});
    expect(screen.queryByTestId('precision-scope-server')).toBeTruthy();
    expect(screen.queryByTestId('precision-scope-drafts')).toBeNull();
    expect(screen.queryByTestId('precision-scope-published')).toBeNull();
    expect(screen.queryByTestId('precision-show-solved')).toBeNull();
    // Objectives видны всем.
    expect(screen.queryByTestId('precision-objective-all')).toBeTruthy();
  });

  it('KS-3347: клик «Мои черновики» добавляет scope=drafts в URL', () => {
    let captured: URLSearchParams | null = null;
    renderBar({ onParams: (sp) => (captured = sp) });
    fireEvent.click(screen.getByTestId('precision-scope-drafts'));
    expect(captured?.get('scope')).toBe('drafts');
    // Legacy params должны быть удалены.
    expect(captured?.has('mine')).toBe(false);
    expect(captured?.has('visibility')).toBe(false);
  });

  it('KS-3347: клик «Серверные» удаляет scope из URL (default)', () => {
    let captured: URLSearchParams | null = null;
    renderBar({
      initialUrl: '/precision?scope=drafts',
      onParams: (sp) => (captured = sp),
    });
    fireEvent.click(screen.getByTestId('precision-scope-server'));
    expect(captured?.has('scope')).toBe(false);
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

  it('KS-3664: pill «+ Рейтинг» больше не рендерится', () => {
    renderBar({});
    expect(screen.queryByTestId('precision-chips-rating-open')).toBeNull();
  });

  it('Reset показывается только при активных фильтрах и очищает URL', () => {
    // Без фильтров — нет кнопки.
    renderBar({});
    expect(screen.queryByTestId('precision-chips-reset')).toBeNull();

    let captured: URLSearchParams | null = null;
    renderBar({
      // KS-3664: blundererEloMin в URL остался от legacy-ссылок — reset
      // должен их вычищать, даже если самого слайдера в UI больше нет.
      initialUrl:
        '/precision?scope=drafts&objective=convertAdvantage&showSolved=true&blundererEloMin=1600',
      onParams: (sp) => (captured = sp),
    });
    const reset = screen.getByTestId('precision-chips-reset');
    fireEvent.click(reset);
    expect(captured?.has('scope')).toBe(false);
    expect(captured?.has('mine')).toBe(false);
    expect(captured?.has('visibility')).toBe(false);
    expect(captured?.has('objective')).toBe(false);
    expect(captured?.has('showSolved')).toBe(false);
    expect(captured?.has('blundererEloMin')).toBe(false);
    expect(captured?.has('blundererEloMax')).toBe(false);
  });
});
