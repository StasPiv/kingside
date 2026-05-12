import { describe, it, expect } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';
import { AnalyzeLobbyPage } from './AnalyzeLobbyPage';

/**
 * KS-2797 (ADR-058 §6.1 T2): рендер `AnalyzeLobbyPage` — 2 карточки
 * без gating'а (Workshop, Archive).
 */
describe('AnalyzeLobbyPage (KS-2797)', () => {
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
