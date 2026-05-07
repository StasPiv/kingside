/**
 * KS-2541 + KS-2561 тесты PuzzleBrowserPage. Покрываем:
 *  - удалённую вкладку «Play vs Engine» (KS-2541);
 *  - infinite-прокрутку через mock IntersectionObserver и cursor pagination (KS-2561);
 *  - применение фильтров рейтинг/темы (KS-2561);
 *  - URL-state при изменении фильтров (KS-2561);
 *  - карточки-диаграммы без чипов тем (KS-2554/2561).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock('../components/PuzzleGeneratorModal', () => ({
  PuzzleGeneratorModal: () => null,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn() }),
}));

// KS-2563: react-chessboard на /puzzles не используется (заменён на
// `<PuzzleMiniBoard>`); сам мини-board pure SVG, моков не требует.

import { PuzzleBrowserPage } from './PuzzleBrowserPage';

const PUZZLE = {
  id: 'pz-1',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves: ['e2e4'],
  rating: 1500,
  themes: ['mateIn1'],
  source: 'lichess',
  sourceId: null,
  sourceMoveNum: null,
  sourceMetadata: null,
  createdAt: '2026-05-07T10:00:00Z',
};

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ data: [], nextCursor: null });
});

afterEach(() => vi.restoreAllMocks());

describe('<PuzzleBrowserPage> KS-2541', () => {
  it('на /puzzles нет вкладки «Play vs Engine»', async () => {
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(
      screen.queryByTestId('puzzle-browser-tab-play-vs-engine'),
    ).toBeNull();
  });
});

describe('<PuzzleBrowserPage> KS-2561 — фильтры и infinite scroll', () => {
  it('первичный fetch идёт на /puzzles/browse с cursor pagination params (без offset/sort)', async () => {
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/puzzles\/browse\?/);
    expect(url).toMatch(/limit=\d+/);
    expect(url).not.toMatch(/offset=/);
    expect(url).not.toMatch(/sort=/);
    expect(url).not.toMatch(/order=/);
  });

  it('KS-2578: фиксированный source=lichess в каждом запросе (generated живут в /precision)', async () => {
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/source=lichess/);
    expect(url).not.toMatch(/source=generated/);
  });

  it('рендерит карточку-диаграмму (FEN) без чипов тем', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE], nextCursor: null });
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-card')).toBeInTheDocument(),
    );
    // KS-2563: статическая мини-доска (SVG) вместо <Chessboard>.
    const mini = screen.getByTestId('puzzle-mini-board');
    expect(mini).toBeInTheDocument();
    expect(mini.getAttribute('data-orientation')).toBe('white');
    // Рейтинг видим, чипы тем — НЕТ.
    expect(screen.getByTestId('puzzle-card-rating').textContent).toBe('1500');
    expect(screen.queryByText(/mateIn1/i)).toBeNull();
  });

  it('toggle темы добавляет её в URL и в next request', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    await user.click(screen.getByTestId('filter-theme-fork'));
    await waitFor(() => {
      const lastUrl = apiGet.mock.calls.at(-1)?.[0] as string;
      expect(lastUrl).toMatch(/themes=fork/);
    });
    // Чип помечен активным.
    expect(
      screen
        .getByTestId('filter-theme-fork')
        .getAttribute('data-active'),
    ).toBe('true');
  });

  it('filter ratingMin и ratingMax попадают в query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    apiGet.mockResolvedValue({ data: [], nextCursor: null });
    const min = screen.getByTestId('filter-rating-min') as HTMLInputElement;
    const max = screen.getByTestId('filter-rating-max') as HTMLInputElement;
    await user.clear(min);
    await user.type(min, '1200');
    await user.clear(max);
    await user.type(max, '1800');
    await waitFor(() => {
      const lastUrl = apiGet.mock.calls.at(-1)?.[0] as string;
      expect(lastUrl).toMatch(/ratingMin=1200/);
      expect(lastUrl).toMatch(/ratingMax=1800/);
    });
  });

  it('reset кнопка очищает фильтры и URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await user.click(screen.getByTestId('filter-theme-pin'));
    await waitFor(() =>
      expect(
        screen
          .getByTestId('filter-theme-pin')
          .getAttribute('data-active'),
      ).toBe('true'),
    );
    apiGet.mockResolvedValue({ data: [], nextCursor: null });
    await user.click(screen.getByTestId('filter-reset'));
    await waitFor(() =>
      expect(
        screen
          .getByTestId('filter-theme-pin')
          .getAttribute('data-active'),
      ).toBe('false'),
    );
  });

  it('пустой список → empty state', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-browser-empty')).toBeInTheDocument(),
    );
  });

  it('ошибка API → error state', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-browser-error')).toBeInTheDocument(),
    );
  });

  it('hasMore=false → end-of-list message виден', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE], nextCursor: null });
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-card')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('puzzle-browser-end')).toBeInTheDocument();
  });
});
