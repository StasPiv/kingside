import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2886 / ADR-060 §3.4 (FC1). Smoke + behaviour-тесты нового
 * каталога Studies: табы Hot/New/Updated/Popular/Mine, поиск с
 * debounce, topic-chip фильтр, URL-state, infinite-scroll sentinel,
 * Create-CTA на табе Mine.
 */

const getCatalogMock = vi.fn();
const createMock = vi.fn();

vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getCatalog: (opts: unknown) => getCatalogMock(opts),
    create: (req: unknown) => createMock(req),
    // Используется LikeButton внутри StudyCatalogCard.
    toggleLike: vi.fn(),
  },
}));

const authState: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, token: null, loading: false }),
}));

// Заглушка IntersectionObserver на happy-dom — sentinel в DOM есть,
// но observer не вызывает callback автоматически.
class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  FakeIO;

import { StudiesPage } from './StudiesPage';

const SAMPLE = [
  {
    id: 's1',
    ownerId: 'u-aaa',
    slug: 'opening-traps',
    name: 'Opening traps',
    description: 'Sharp lines',
    isPublic: true,
    visibility: 'public',
    topics: ['openings', 'tactics'],
    likes: 17,
    fromKind: 'scratch',
    fromRefId: null,
    chaptersCount: 4,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    // KS-2994 / KS-2995: backend кладёт POV-флаг в каждую запись
    // каталога; фронт читает study.likedByMe в LikeButton.
    likedByMe: false,
    viewerRole: 'viewer',
  },
  {
    id: 's2',
    ownerId: 'u-bbb',
    slug: 'rook-endings',
    name: 'Rook endings',
    description: null,
    isPublic: true,
    visibility: 'public',
    topics: ['endgames'],
    likes: 3,
    fromKind: 'scratch',
    fromRefId: null,
    chaptersCount: 9,
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
    likedByMe: true,
    viewerRole: 'viewer',
  },
];

beforeEach(() => {
  getCatalogMock.mockReset();
  createMock.mockReset();
  getCatalogMock.mockResolvedValue({
    items: SAMPLE,
    total: SAMPLE.length,
    hasMore: false,
  });
  authState.user = { id: 'u1', username: 'tester' };
  vi.useRealTimers();
});

describe('StudiesPage catalog (KS-2886)', () => {
  it('по умолчанию /studies → sort=hot, фетчит каталог', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(getCatalogMock.mock.calls[0][0]).toMatchObject({
      sort: 'hot',
      mine: false,
    });
    expect(
      screen.getByTestId('studies-tab-hot').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('таб «New» обновляет URL и шлёт запрос с sort=new', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('studies-tab-new'));
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(2));
    expect(getCatalogMock.mock.calls[1][0]).toMatchObject({ sort: 'new' });
    expect(
      screen.getByTestId('studies-tab-new').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('таб «Mine» → mine=true в запросе и виден Create-CTA', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies?sort=mine' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(getCatalogMock.mock.calls[0][0]).toMatchObject({ mine: true });
    expect(screen.getByTestId('studies-create-btn')).toBeInTheDocument();
  });

  it('гость: таб «Mine» НЕ рендерится; sort=mine в URL → fallback на hot', async () => {
    authState.user = null;
    renderWithProviders(<StudiesPage />, { route: '/studies?sort=mine' });
    expect(screen.queryByTestId('studies-tab-mine')).toBeNull();
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(getCatalogMock.mock.calls[0][0]).toMatchObject({
      sort: 'hot',
      mine: false,
    });
  });

  it('?sort=popular в URL → активен Popular', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies?sort=popular' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(getCatalogMock.mock.calls[0][0]).toMatchObject({
      sort: 'popular',
    });
    expect(
      screen.getByTestId('studies-tab-popular').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('search debounce: ввод не дёргает API сразу, после 300 мс — дёргает с q', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(1));
    const input = screen.getByTestId('studies-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sicilian' } });
    // Сразу после ввода — повторного вызова ещё нет (debounce 300 мс).
    expect(getCatalogMock).toHaveBeenCalledTimes(1);
    // Реальный таймер: ждём чуть больше 300 мс — debounce срабатывает,
    // useEffect перезапускает fetch с q.
    await waitFor(
      () =>
        expect(getCatalogMock).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'sicilian' }),
        ),
      { timeout: 1500 },
    );
  });

  it('клик по topic-chip → topic в URL и в запросе', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    // Topic из items: «openings» (из s1.topics).
    fireEvent.click(screen.getByTestId('studies-topic-chip-openings'));
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(2));
    expect(getCatalogMock.mock.calls[1][0]).toMatchObject({
      topic: 'openings',
    });
    expect(
      screen
        .getByTestId('studies-topic-chip-openings')
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('повторный клик по active chip снимает фильтр', async () => {
    renderWithProviders(<StudiesPage />, {
      route: '/studies?topic=openings',
    });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(getCatalogMock.mock.calls[0][0]).toMatchObject({
      topic: 'openings',
    });
    fireEvent.click(screen.getByTestId('studies-topic-chip-openings'));
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(2));
    expect(getCatalogMock.mock.calls[1][0].topic).toBeUndefined();
  });

  it('Clear filters стирает topic и q из URL', async () => {
    renderWithProviders(<StudiesPage />, {
      route: '/studies?topic=openings&q=alpha',
    });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('studies-clear-filters'));
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(2));
    const lastCall = getCatalogMock.mock.calls[getCatalogMock.mock.calls.length - 1][0];
    expect(lastCall.topic).toBeUndefined();
    expect(lastCall.q).toBeUndefined();
  });

  it('items → грид с карточками; empty → empty-state', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-grid')).toBeInTheDocument(),
    );
    // Карточки используют data-testid="study-catalog-card" из FC2.
    expect(screen.getAllByTestId('study-catalog-card')).toHaveLength(2);

    getCatalogMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      hasMore: false,
    });
    fireEvent.click(screen.getByTestId('studies-tab-popular'));
    await waitFor(() =>
      expect(screen.getByTestId('studies-empty')).toBeInTheDocument(),
    );
  });

  it('ошибка API → error-state', async () => {
    getCatalogMock.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-error')).toBeInTheDocument(),
    );
  });

  it('hasMore=true → рендерится sentinel для infinite scroll', async () => {
    getCatalogMock.mockResolvedValueOnce({
      items: SAMPLE,
      total: 50,
      hasMore: true,
    });
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(
        screen.getByTestId('studies-load-more-sentinel'),
      ).toBeInTheDocument(),
    );
  });

  it('hasMore=false → sentinel НЕ рендерится', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-grid')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('studies-load-more-sentinel'),
    ).not.toBeInTheDocument();
  });
});

describe('StudiesPage Create-CTA (KS-2886)', () => {
  it('Mine + auth → видна кнопка «+ Создать студию»', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies?sort=mine' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(screen.getByTestId('studies-create-btn')).toBeInTheDocument();
  });

  it('Hot/auth → кнопка скрыта (создание только на табе Mine)', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies?sort=hot' });
    await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    expect(screen.queryByTestId('studies-create-btn')).not.toBeInTheDocument();
  });

  it('Mine empty + auth → дублирующий CTA в empty-state', async () => {
    getCatalogMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      hasMore: false,
    });
    renderWithProviders(<StudiesPage />, { route: '/studies?sort=mine' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-empty')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('studies-empty-create-btn'),
    ).toBeInTheDocument();
  });
});
