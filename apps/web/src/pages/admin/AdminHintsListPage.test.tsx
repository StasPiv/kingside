// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n/index';
import { AdminHintsListPage } from './AdminHintsListPage';

const API_BASE = 'http://localhost:3001';

const sample = [
  {
    id: 'h-1',
    key: 'analyze-your-game',
    anchor: 'game-end-analysis-button',
    placement: 'bottom',
    enabled: true,
    priority: 10,
    targetActorTypes: ['user'],
    titleRu: 'Разобрать',
    titleEn: 'Analyse',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'h-2',
    key: 'guest-register-prompt',
    anchor: 'landing-signup-button',
    placement: 'top',
    enabled: false,
    priority: 5,
    targetActorTypes: ['guest'],
    titleRu: 'Зарегистрируйтесь',
    titleEn: 'Sign up',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
    deletedAt: '2026-06-23T00:00:00.000Z',
  },
];

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/admin/hints']}>
        <AdminHintsListPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('AdminHintsListPage (KS-4706)', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('загружает список и рендерит таблицу', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('admin-hints-table')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('admin-hints-row-analyze-your-game')).toBeInTheDocument();
    expect(screen.getByTestId('admin-hints-row-guest-register-prompt')).toBeInTheDocument();
  });

  it('фильтр enabled добавляется в query', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-hints-table'));
    vi.mocked(fetch).mockClear();
    await act(async () => {
      fireEvent.change(screen.getByTestId('admin-hints-filter-enabled'), {
        target: { value: 'on' },
      });
    });
    await waitFor(() => {
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      expect(url).toBe(`${API_BASE}/admin/hints?enabled=true`);
    });
  });

  it('toggle enabled вызывает PATCH /:id/status', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-hints-table'));
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'h-1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sample), { status: 200 }),
      );

    await act(async () => {
      fireEvent.click(screen.getByTestId('admin-hints-toggle-analyze-your-game'));
    });
    const patch = vi.mocked(fetch).mock.calls[0];
    expect(patch[0]).toBe(`${API_BASE}/admin/hints/h-1/status`);
    expect((patch[1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({
      enabled: false,
    });
  });

  it('confirm + delete вызывает DELETE', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-hints-table'));
    fireEvent.click(screen.getByTestId('admin-hints-delete-analyze-your-game'));
    expect(screen.getByTestId('admin-hints-delete-confirm')).toBeInTheDocument();

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sample), { status: 200 }),
      );
    await act(async () => {
      fireEvent.click(screen.getByTestId('admin-hints-delete-confirm-yes'));
    });
    const del = vi.mocked(fetch).mock.calls[0];
    expect(del[0]).toBe(`${API_BASE}/admin/hints/h-1`);
    expect((del[1] as RequestInit).method).toBe('DELETE');
  });

  it('soft-deleted row показывает кнопку Restore вместо Delete', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('admin-hints-table'));
    expect(
      screen.getByTestId('admin-hints-restore-guest-register-prompt'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('admin-hints-delete-guest-register-prompt'),
    ).not.toBeInTheDocument();
  });
});
