import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';

const apiGet = vi.fn();
vi.mock('../../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

import { DrillStatsPanel } from './DrillStatsPanel';

const FULL_STATS = {
  total: { attempts: 24, solved: 18, accuracy: 0.75 },
  byType: [
    { drillType: 'count-attackers', attempts: 6, solved: 5, accuracy: 0.833, avgTimeMs: 4200 },
    { drillType: 'find-loose-piece', attempts: 4, solved: 3, accuracy: 0.75, avgTimeMs: 3100 },
    { drillType: 'find-hanging-piece', attempts: 3, solved: 3, accuracy: 1.0, avgTimeMs: 2800 },
    { drillType: 'find-all-checks', attempts: 5, solved: 3, accuracy: 0.6, avgTimeMs: 7500, avgIou: 0.71 },
    { drillType: 'find-pin', attempts: 4, solved: 2, accuracy: 0.5, avgTimeMs: 6200 },
    { drillType: 'find-fork', attempts: 2, solved: 2, accuracy: 1.0, avgTimeMs: 5400 },
    // find-mate-in-one-square / find-undefended-attack — нет попыток.
  ],
  unlocked: ['count-attackers', 'find-loose-piece', 'find-hanging-piece'],
};

beforeEach(() => apiGet.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('<DrillStatsPanel> KS-2236', () => {
  it('mount → loading → loaded после ответа /stats/me', async () => {
    apiGet.mockResolvedValue(FULL_STATS);
    renderWithProviders(<DrillStatsPanel />);
    expect(
      screen.getByTestId('drill-stats-panel').getAttribute('data-state'),
    ).toBe('loading');
    await waitFor(() =>
      expect(
        screen.getByTestId('drill-stats-panel').getAttribute('data-state'),
      ).toBe('loaded'),
    );
    expect(apiGet).toHaveBeenCalledWith('/tactic-drill/stats/me');
  });

  it('summary показывает total attempts/solved/accuracy', async () => {
    apiGet.mockResolvedValue(FULL_STATS);
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId('drill-stats-panel-summary'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('drill-stats-panel-total-attempts').textContent).toBe(
      '24',
    );
    expect(screen.getByTestId('drill-stats-panel-total-solved').textContent).toBe(
      '18',
    );
    // 0.75 → 75%.
    expect(
      screen.getByTestId('drill-stats-panel-total-accuracy').textContent,
    ).toBe('75%');
  });

  it('таблица содержит все 8 строк в порядке методики', async () => {
    apiGet.mockResolvedValue(FULL_STATS);
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'loaded',
      ),
    );
    const rows = document.querySelectorAll('[data-drill-type]');
    expect(rows).toHaveLength(8);
    const order = Array.from(rows).map((r) => r.getAttribute('data-drill-type'));
    expect(order).toEqual([
      'count-attackers',
      'find-loose-piece',
      'find-hanging-piece',
      'find-all-checks',
      'find-pin',
      'find-fork',
      'find-mate-in-one-square',
      'find-undefended-attack',
    ]);
  });

  it('строка типа без попыток (find-mate-in-one-square) → нули в ячейках', async () => {
    apiGet.mockResolvedValue(FULL_STATS);
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'loaded',
      ),
    );
    const row = document.querySelector(
      '[data-drill-type="find-mate-in-one-square"]',
    ) as HTMLTableRowElement;
    expect(row).toBeTruthy();
    // accuracy = 0 → "—".
    expect(row.textContent).toContain('—');
  });

  it('unlocked-бейдж проставляется только трем разблокированным типам', async () => {
    apiGet.mockResolvedValue(FULL_STATS);
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'loaded',
      ),
    );
    const unlockedRows = document.querySelectorAll(
      '[data-drill-type][data-unlocked="true"]',
    );
    expect(unlockedRows).toHaveLength(3);
    const lockedRows = document.querySelectorAll(
      '[data-drill-type][data-unlocked="false"]',
    );
    expect(lockedRows).toHaveLength(5);
  });

  it('total.attempts = 0 → empty-state с CTA-ссылкой на /drills', async () => {
    apiGet.mockResolvedValue({
      total: { attempts: 0, solved: 0, accuracy: 0 },
      byType: [],
      unlocked: [],
    });
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'empty',
      ),
    );
    const cta = screen.getByTestId('drill-stats-panel-cta') as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/drills');
  });

  it('lobbyHref=null → CTA-ссылка скрыта в empty-state', async () => {
    apiGet.mockResolvedValue({
      total: { attempts: 0, solved: 0, accuracy: 0 },
      byType: [],
      unlocked: [],
    });
    renderWithProviders(<DrillStatsPanel lobbyHref={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'empty',
      ),
    );
    expect(
      screen.queryByTestId('drill-stats-panel-cta'),
    ).not.toBeInTheDocument();
  });

  it('IoU отображается только если avgIou задан в строке', async () => {
    apiGet.mockResolvedValue(FULL_STATS);
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'loaded',
      ),
    );
    const checksRow = document.querySelector(
      '[data-drill-type="find-all-checks"]',
    ) as HTMLTableRowElement;
    expect(checksRow.textContent).toContain('0.71');
    const otherRow = document.querySelector(
      '[data-drill-type="count-attackers"]',
    ) as HTMLTableRowElement;
    // count-attackers без avgIou → "—" в IoU-колонке.
    const cells = otherRow.querySelectorAll('td');
    expect(cells[5].textContent).toBe('—');
  });

  it('avgTime: <1000ms → "Xms", >=1s → "X.Xs/Xs"', async () => {
    apiGet.mockResolvedValue({
      total: { attempts: 2, solved: 1, accuracy: 0.5 },
      byType: [
        { drillType: 'count-attackers', attempts: 1, solved: 1, accuracy: 1, avgTimeMs: 850 },
        { drillType: 'find-loose-piece', attempts: 1, solved: 0, accuracy: 0, avgTimeMs: 12500 },
      ],
      unlocked: [],
    });
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel').getAttribute('data-state')).toBe(
        'loaded',
      ),
    );
    const r1 = document.querySelector('[data-drill-type="count-attackers"]') as HTMLTableRowElement;
    const r2 = document.querySelector('[data-drill-type="find-loose-piece"]') as HTMLTableRowElement;
    expect(r1.textContent).toContain('850 ms');
    expect(r2.textContent).toContain('13 s');
  });

  it('CTA-ссылка в empty-state кликабельна и ведёт на /drills', async () => {
    apiGet.mockResolvedValue({
      total: { attempts: 0, solved: 0, accuracy: 0 },
      byType: [],
      unlocked: [],
    });
    const user = userEvent.setup();
    renderWithProviders(<DrillStatsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('drill-stats-panel-cta')).toBeInTheDocument(),
    );
    // userEvent.click на Link — не падает (это валидный <a>).
    await user.click(screen.getByTestId('drill-stats-panel-cta'));
    // Внутри MemoryRouter навигация состоится; подтверждаем класс/текст.
    expect(screen.getByTestId('drill-stats-panel-cta').textContent).toMatch(
      /trainer|тренажёр/i,
    );
  });

  // KS-2236: тест error-state намеренно не делается unit-тестом —
  // vitest 4 в happy-dom + strict unhandled-rejection policy
  // (`apps/web/src/test/setup.ts`) ловит rejected promise из api-mock
  // как unhandled и валит тест ДО того, как .catch внутри useEffect
  // успевает отработать. Логика error-state простая (устанавливает
  // state='error' и рендерит drill-stats-panel--error class) — она
  // валидируется на интеграционном уровне (ProfilePage не падает на
  // 401 от /stats/me).
});
