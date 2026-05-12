import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2796 (ADR-058 §6.1 T1): рендер `TrainLobbyPage` при разных
 * комбинациях feature-flag'ов. Mock'аем `useFeatureFlag`, чтобы
 * не дёргать FeatureFlagsContext (он подтягивает реальный API).
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

import { TrainLobbyPage } from './TrainLobbyPage';

beforeEach(() => {
  flagsState.puzzlesEnabled = true;
  flagsState.drillsEnabled = true;
});

describe('TrainLobbyPage (KS-2796)', () => {
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
    // KS-2796: Rush не gated; остаётся даже если puzzlesEnabled и
    // drillsEnabled оба false. Coming-soon-fallback рендерится только
    // если 4 из 4 модуля выключены — то есть в текущей реализации
    // никогда (Rush всегда true). Тест зафиксирует это поведение.
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
