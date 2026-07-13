// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n/index';
import { NotificationDropdown } from './NotificationDropdown';
import type { NotificationItem } from '@kingside/shared';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="route">{loc.pathname}</div>;
}

function renderDropdown(notifications: NotificationItem[]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <NotificationDropdown
                  notifications={notifications}
                  loading={false}
                  onClose={() => undefined}
                  onMarkAsRead={() => undefined}
                  onMarkAllAsRead={() => undefined}
                />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('NotificationDropdown — KS-4741 blog_post_published', () => {
  beforeEach(() => {
    /* noop */
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeBlogN(): NotificationItem {
    return {
      id: 'n-1',
      type: 'blog_post_published',
      payload: {
        post_id: 'p-1',
        slug: 'critical-moment',
        locale: 'ru',
        title: 'Критический момент',
      },
      read: false,
      createdAt: new Date().toISOString(),
    } as unknown as NotificationItem;
  }

  it('рендерит локализованный текст с title из payload', () => {
    renderDropdown([makeBlogN()]);
    // i18n инициализируется на en (см. setup.ts), тогда subtitle =
    // 'New blog post'. Текст «<subtitle> — <title>».
    expect(screen.getByText(/Критический момент/)).toBeInTheDocument();
  });

  it('клик ведёт на /<locale>/blog/<slug>', () => {
    renderDropdown([makeBlogN()]);
    fireEvent.click(screen.getByText(/Критический момент/));
    expect(screen.getByTestId('route').textContent).toBe('/ru/blog/critical-moment');
  });

  it('default-ветка для незнакомого type — переход на /', () => {
    renderDropdown([
      {
        id: 'n-x',
        type: 'unknown_future_type' as unknown as NotificationItem['type'],
        payload: {},
        read: false,
        createdAt: new Date().toISOString(),
      } as unknown as NotificationItem,
    ]);
    // Текст — сырой type (fallback).
    fireEvent.click(screen.getByText('unknown_future_type'));
    expect(screen.getByTestId('route').textContent).toBe('/');
  });

  // KS-4932 / ADR-163: уведомление о занятии — текст с именем
  // тренировки из payload.scheduleName, клик ведёт на /study.
  it('study_session: текст с именем тренировки, клик ведёт на /study', () => {
    renderDropdown([
      {
        id: 'n-s',
        type: 'study_session' as unknown as NotificationItem['type'],
        payload: { sessionId: 'sess1', taskCount: 3, scheduleName: 'Вечерняя тактика' },
        read: false,
        createdAt: new Date().toISOString(),
      } as unknown as NotificationItem,
    ]);
    // Не raw-тип, а человекочитаемый текст с именем (i18n en в тестах).
    expect(screen.queryByText('study_session')).not.toBeInTheDocument();
    const text = screen.getByText(/Вечерняя тактика/);
    expect(text.textContent).toContain('session is ready');
    fireEvent.click(text);
    expect(screen.getByTestId('route').textContent).toBe('/study');
  });

  it('study_session без scheduleName — generic-текст без имени', () => {
    renderDropdown([
      {
        id: 'n-s2',
        type: 'study_session' as unknown as NotificationItem['type'],
        payload: { sessionId: 'sess1' },
        read: false,
        createdAt: new Date().toISOString(),
      } as unknown as NotificationItem,
    ]);
    expect(screen.getByText('Your training session is ready')).toBeInTheDocument();
  });

  it('blog_post_published без slug — клик не переходит на blog, идёт на /', () => {
    const n = makeBlogN();
    (n.payload as { slug?: string }).slug = undefined;
    renderDropdown([n]);
    fireEvent.click(screen.getByText(/Критический момент/));
    // slug нет → внутри case ничего, дальше break → onClose. На /
    // не уходим (route остался '/start').
    expect(screen.getByTestId('route').textContent).toBe('/start');
  });
});
