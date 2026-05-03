import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../test/test-utils';
import { Route, Routes } from 'react-router-dom';
import { DrillSprintResultsPage } from './DrillSprintResultsPage';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => navigateMock };
});

afterEach(() => {
  vi.restoreAllMocks();
  navigateMock.mockReset();
});

function renderWithState(state: unknown) {
  // Заворачиваем в Routes/Route, чтобы useLocation видел реальный
  // initialEntry с state.
  return renderWithProviders(
    <Routes>
      <Route path="/drills/sprint/results" element={<DrillSprintResultsPage />} />
    </Routes>,
    { route: '/drills/sprint/results' },
  );
}

// renderWithProviders передаёт MemoryRouter с initialEntries=[route];
// state туда не пробрасывается. Вместо мок-роутера строим вручную.
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en/translation.json';
const testI18n = i18n.createInstance();
testI18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

function renderResults(state: unknown) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter initialEntries={[{ pathname: '/drills/sprint/results', state }]}>
        <Routes>
          <Route path="/drills/sprint/results" element={<DrillSprintResultsPage />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('<DrillSprintResultsPage> KS-2241', () => {
  it('без state → missing-баннер с кнопкой Play again', () => {
    renderResults(null);
    const root = screen.getByTestId('drill-sprint-results');
    expect(root.getAttribute('data-state')).toBe('missing');
    expect(
      screen.getByTestId('drill-sprint-results-play-again'),
    ).toBeInTheDocument();
  });

  it('Play again в missing-state → navigate("/drills/sprint", replace)', async () => {
    const user = userEvent.setup();
    renderResults(null);
    await user.click(screen.getByTestId('drill-sprint-results-play-again'));
    expect(navigateMock).toHaveBeenCalledWith(
      '/drills/sprint',
      expect.objectContaining({ replace: true }),
    );
  });

  it('full state → render score/accuracy/avgPrecision', () => {
    renderResults({
      final: {
        scoreId: 'sc-42',
        score: 18,
        accuracy: 0.75,
        avgPrecision: 0.71,
      },
      ended: 'submitted',
    });
    const root = screen.getByTestId('drill-sprint-results');
    expect(root.getAttribute('data-state')).toBe('loaded');
    expect(root.getAttribute('data-ended')).toBe('submitted');
    expect(root.getAttribute('data-score-id')).toBe('sc-42');
    expect(screen.getByTestId('drill-sprint-results-score').textContent).toBe('18');
    expect(screen.getByTestId('drill-sprint-results-accuracy').textContent).toBe('75%');
    expect(screen.getByTestId('drill-sprint-results-avg-precision').textContent).toBe(
      '0.71',
    );
  });

  it('avgPrecision=0 → "—" (нет shape="squares" задач)', () => {
    renderResults({
      final: {
        scoreId: 'sc-1',
        score: 5,
        accuracy: 0.5,
        avgPrecision: 0,
      },
      ended: 'expired',
    });
    expect(screen.getByTestId('drill-sprint-results-avg-precision').textContent).toBe(
      '—',
    );
    expect(screen.getByTestId('drill-sprint-results').getAttribute('data-ended')).toBe(
      'expired',
    );
  });

  it('кнопки навигации: leaderboard и lobby — корректные href', () => {
    renderResults({
      final: { scoreId: 's', score: 1, accuracy: 1, avgPrecision: 0 },
      ended: 'submitted',
    });
    expect(
      (screen.getByTestId('drill-sprint-results-leaderboard') as HTMLAnchorElement).getAttribute(
        'href',
      ),
    ).toBe('/drills/sprint/leaderboard');
    expect(
      (screen.getByTestId('drill-sprint-results-lobby') as HTMLAnchorElement).getAttribute(
        'href',
      ),
    ).toBe('/drills');
  });
});
