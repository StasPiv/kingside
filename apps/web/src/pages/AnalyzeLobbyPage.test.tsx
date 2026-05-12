import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2797 (ADR-058 §6.1 T2) + KS-2844 (ADR-058 §11.5):
 * - На mobile рендерится грид карточек (Workshop, Archive).
 * - На desktop редирект на /workshop.
 */

const mobileState = { isMobile: true };
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => mobileState.isMobile,
}));

import { AnalyzeLobbyPage } from './AnalyzeLobbyPage';

beforeEach(() => {
  mobileState.isMobile = true;
});

describe('AnalyzeLobbyPage (KS-2797) — mobile render', () => {
  it('рендерит 2 карточки', () => {
    renderWithProviders(<AnalyzeLobbyPage />, { route: '/analyze' });
    expect(screen.getByTestId('analyze-lobby-page')).toBeInTheDocument();
    expect(screen.getByTestId('analyze-lobby-grid')).toBeInTheDocument();
    expect(screen.getByTestId('analyze-lobby-card-workshop')).toBeInTheDocument();
    expect(screen.getByTestId('analyze-lobby-card-archive')).toBeInTheDocument();
  });

  it('карточки ведут на правильные маршруты', () => {
    renderWithProviders(<AnalyzeLobbyPage />, { route: '/analyze' });
    expect(
      screen.getByTestId('analyze-lobby-card-workshop').getAttribute('href'),
    ).toBe('/workshop');
    expect(
      screen.getByTestId('analyze-lobby-card-archive').getAttribute('href'),
    ).toBe('/archive');
  });
});

describe('AnalyzeLobbyPage KS-2844 — desktop redirect', () => {
  it('desktop → редирект на /workshop', () => {
    mobileState.isMobile = false;
    renderWithProviders(
      <Routes>
        <Route path="/analyze" element={<AnalyzeLobbyPage />} />
        <Route path="/workshop" element={<div data-testid="workshop-stub" />} />
      </Routes>,
      { route: '/analyze' },
    );
    expect(screen.getByTestId('workshop-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('analyze-lobby-page')).not.toBeInTheDocument();
  });
});
