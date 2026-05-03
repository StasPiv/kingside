import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'me-user-id', username: 'DEV' },
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DrillLeaderboardPage } from './DrillLeaderboardPage';

const ENTRIES = [
  {
    userId: 'user-a',
    username: 'Alice',
    mode: '3min-mixed',
    score: 24,
    accuracy: 0.85,
    createdAt: '2026-05-01T12:00:00Z',
  },
  {
    userId: 'me-user-id',
    username: 'DEV',
    mode: '3min-mixed',
    score: 18,
    accuracy: 0.75,
    createdAt: '2026-05-02T13:00:00Z',
  },
  {
    userId: 'user-c',
    username: 'Carol',
    mode: '3min-mixed',
    score: 12,
    accuracy: 0.6,
    createdAt: '2026-05-03T14:00:00Z',
  },
];

beforeEach(() => apiGet.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('<DrillLeaderboardPage> KS-2242', () => {
  it('mount → дёргает /sprint/leaderboard?mode=3min-mixed&period=allTime (default)', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: ENTRIES });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet).toHaveBeenCalledWith(
      '/tactic-drill/sprint/leaderboard?mode=3min-mixed&period=allTime',
    );
  });

  it('рендерит 3 fieldset фильтров с правильным count radio', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.getByTestId('drill-leaderboard-duration')).toBeInTheDocument();
    expect(screen.getByTestId('drill-leaderboard-set')).toBeInTheDocument();
    expect(screen.getByTestId('drill-leaderboard-period')).toBeInTheDocument();
    // 2 duration + 4 sets + 3 periods = 9 radio.
    const radios = document.querySelectorAll(
      'input[type="radio"][data-testid^="drill-leaderboard-"]',
    );
    expect(radios).toHaveLength(2 + 4 + 3);
  });

  it('default: 3 min + mixed + allTime отмечены, root data-mode/period выставлены', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const root = screen.getByTestId('drill-leaderboard');
    expect(root.getAttribute('data-mode')).toBe('3min-mixed');
    expect(root.getAttribute('data-period')).toBe('allTime');
    expect(
      (screen.getByTestId('drill-leaderboard-duration-3') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('drill-leaderboard-set-mixed') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('drill-leaderboard-period-allTime') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('переключение duration → 5min: новый запрос с mode=5min-mixed', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    const user = userEvent.setup();
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId('drill-leaderboard-duration-5'));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/tactic-drill/sprint/leaderboard?mode=5min-mixed&period=allTime',
      ),
    );
  });

  it('переключение drill-set → overview: mode=3min-overview', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    const user = userEvent.setup();
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId('drill-leaderboard-set-overview'));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/tactic-drill/sprint/leaderboard?mode=3min-overview&period=allTime',
      ),
    );
  });

  it('переключение period → day/week: новый запрос', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    const user = userEvent.setup();
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId('drill-leaderboard-period-day'));
    await waitFor(() =>
      expect(apiGet).toHaveBeenLastCalledWith(
        '/tactic-drill/sprint/leaderboard?mode=3min-mixed&period=day',
      ),
    );
    await user.click(screen.getByTestId('drill-leaderboard-period-week'));
    await waitFor(() =>
      expect(apiGet).toHaveBeenLastCalledWith(
        '/tactic-drill/sprint/leaderboard?mode=3min-mixed&period=week',
      ),
    );
  });

  it('пустой ответ → empty-state', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-leaderboard-empty')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('drill-leaderboard-table')).not.toBeInTheDocument();
  });

  it('таблица: 3 строки в порядке ответа, ранг 1..N, accuracy в %, дата формата', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: ENTRIES });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-leaderboard-table')).toBeInTheDocument(),
    );
    const rows = document.querySelectorAll(
      '[data-testid="drill-leaderboard-table"] tbody tr',
    );
    expect(rows).toHaveLength(3);
    // Первая строка — Alice, ранг 1, score 24, accuracy 85%.
    const firstCells = rows[0].querySelectorAll('td');
    expect(firstCells[0].textContent).toBe('1');
    expect(firstCells[1].textContent).toBe('Alice');
    expect(firstCells[2].textContent).toBe('24');
    expect(firstCells[3].textContent).toBe('85%');
  });

  it('подсветка строки текущего пользователя через data-current="true"', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: ENTRIES });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-leaderboard-table')).toBeInTheDocument(),
    );
    const currentRow = document.querySelector(
      '[data-current="true"]',
    ) as HTMLTableRowElement;
    expect(currentRow).not.toBeNull();
    expect(currentRow.getAttribute('data-user-id')).toBe('me-user-id');
  });

  // error-state намеренно не unit-тестируется — vitest 4 в happy-dom
  // строго ловит unhandled promise rejection из api-mock до того как
  // .then(s, fail) успеет навесить fail-handler. Логика error простая
  // (`state='error'` + `[data-testid="drill-leaderboard-error"]`),
  // покрывается e2e/integration на проде.

  it('back-link ведёт на /drills/sprint', async () => {
    apiGet.mockResolvedValue({ mode: '3min-mixed', entries: [] });
    renderWithProviders(<DrillLeaderboardPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const back = screen.getByTestId('drill-leaderboard-back') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toBe('/drills/sprint');
  });
});
