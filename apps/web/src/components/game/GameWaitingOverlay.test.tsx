import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { GameWaitingOverlay } from './GameWaitingOverlay';

describe('KS-4292 / ADR-134 §6: GameWaitingOverlay', () => {
  it('рендерит заголовок «Searching for opponent…»', () => {
    renderWithProviders(<GameWaitingOverlay />);
    expect(screen.getByTestId('game-waiting-overlay')).toBeInTheDocument();
    expect(
      screen.getByText('Searching for opponent…'),
    ).toBeInTheDocument();
  });

  it('подпись отсутствует, если не переданы режим и контроль времени', () => {
    renderWithProviders(<GameWaitingOverlay />);
    expect(
      screen.queryByTestId('game-waiting-overlay-subtitle'),
    ).not.toBeInTheDocument();
  });

  it('подпись содержит только режим, если контроль времени не передан', () => {
    renderWithProviders(<GameWaitingOverlay mode="Blitz" />);
    expect(screen.getByTestId('game-waiting-overlay-subtitle')).toHaveTextContent(
      'Blitz',
    );
  });

  it('подпись «Blitz · 5+0» при обоих заданных значениях', () => {
    renderWithProviders(
      <GameWaitingOverlay mode="Blitz" timeControl="5+0" />,
    );
    expect(screen.getByTestId('game-waiting-overlay-subtitle')).toHaveTextContent(
      'Blitz · 5+0',
    );
  });
});
