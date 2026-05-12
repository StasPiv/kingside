import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2796 (ADR-058 §6.1 T1) + KS-2844 (ADR-058 §11.5):
 * - На mobile рендерится грид карточек (по feature-flags).
 * - На desktop редирект на первый разрешённый подраздел.
 */

const flagsState: Record<string, boolean> = {
  puzzlesEnabled: true,
  drillsEnabled: true,
};

vi.mock('../context/FeatureFlagsContext', async () => {
  const actual = await vi.importActual<
    typeof import('../context/FeatureFlagsContext')
  >('../context/FeatureFlagsContext');
  return {
    ...actual,
    useFeatureFlag: (k: keyof typeof flagsState) => flagsState[k] ?? false,
  };
});

// KS-2844: для тестов лобби-страницы мокаем useIsMobile.
const mobileState = { isMobile: true };
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => mobileState.isMobile,
}));

import { TrainLobbyPage } from './TrainLobbyPage';

beforeEach(() => {
  flagsState.puzzlesEnabled = true;
  flagsState.drillsEnabled = true;
  mobileState.isMobile = true;
});

/**
 * Тестируем mobile-рендер. На mobile useIsMobile=true → лобби рендерится
 * с гридом карточек.
 */
describe('TrainLobbyPage (KS-2796) — mobile render', () => {
  it('все флаги включены → 4 карточки', () => {
    renderWithProviders(<TrainLobbyPage />, { route: '/train' });
    expect(screen.getByTestId('train-lobby-page')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-grid')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-puzzles')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-puzzle-rush')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-drills')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-precision')).toBeInTheDocument();
    expect(
      screen.queryByTestId('train-lobby-coming-soon'),
    ).not.toBeInTheDocument();
  });

  it('puzzlesEnabled=false → Puzzles и Precision скрыты, остаются Rush и Drills', () => {
    flagsState.puzzlesEnabled = false;
    renderWithProviders(<TrainLobbyPage />, { route: '/train' });
    expect(
      screen.queryByTestId('train-lobby-card-puzzles'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('train-lobby-card-precision'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-puzzle-rush')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-drills')).toBeInTheDocument();
  });

  it('drillsEnabled=false → Drills скрыта', () => {
    flagsState.drillsEnabled = false;
    renderWithProviders(<TrainLobbyPage />, { route: '/train' });
    expect(
      screen.queryByTestId('train-lobby-card-drills'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-puzzles')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-precision')).toBeInTheDocument();
    expect(screen.getByTestId('train-lobby-card-puzzle-rush')).toBeInTheDocument();
  });

  it('все флаги выключены, Rush всегда видим → 1 карточка, без coming-soon', () => {
    flagsState.puzzlesEnabled = false;
    flagsState.drillsEnabled = false;
    renderWithProviders(<TrainLobbyPage />, { route: '/train' });
    expect(screen.getByTestId('train-lobby-card-puzzle-rush')).toBeInTheDocument();
    expect(
      screen.queryByTestId('train-lobby-coming-soon'),
    ).not.toBeInTheDocument();
  });

  it('кликабельные карточки ведут на правильные маршруты', () => {
    renderWithProviders(<TrainLobbyPage />, { route: '/train' });
    expect(
      screen.getByTestId('train-lobby-card-puzzles').getAttribute('href'),
    ).toBe('/puzzles');
    expect(
      screen.getByTestId('train-lobby-card-puzzle-rush').getAttribute('href'),
    ).toBe('/puzzle-rush');
    expect(
      screen.getByTestId('train-lobby-card-drills').getAttribute('href'),
    ).toBe('/drills');
    expect(
      screen.getByTestId('train-lobby-card-precision').getAttribute('href'),
    ).toBe('/precision');
  });
});

/**
 * KS-2844: desktop redirect.
 */
describe('TrainLobbyPage KS-2844 — desktop redirect', () => {
  it('desktop + puzzlesEnabled=true → редирект на /puzzles', () => {
    mobileState.isMobile = false;
    flagsState.puzzlesEnabled = true;
    renderWithProviders(
      <Routes>
        <Route path="/train" element={<TrainLobbyPage />} />
        <Route path="/puzzles" element={<div data-testid="puzzles-stub" />} />
      </Routes>,
      { route: '/train' },
    );
    expect(screen.getByTestId('puzzles-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('train-lobby-page')).not.toBeInTheDocument();
  });

  it('desktop + puzzlesEnabled=false → редирект на /puzzle-rush', () => {
    mobileState.isMobile = false;
    flagsState.puzzlesEnabled = false;
    flagsState.drillsEnabled = false;
    renderWithProviders(
      <Routes>
        <Route path="/train" element={<TrainLobbyPage />} />
        <Route path="/puzzle-rush" element={<div data-testid="rush-stub" />} />
      </Routes>,
      { route: '/train' },
    );
    expect(screen.getByTestId('rush-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('train-lobby-page')).not.toBeInTheDocument();
  });
});
