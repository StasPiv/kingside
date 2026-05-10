import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { PrecisionBreakdownsResponse } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionBreakdowns } from './PrecisionBreakdowns';

describe('<PrecisionBreakdowns>', () => {
  it('рендерит 3 фазы и top-10 тем', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      byPhase: [
        { phase: 'opening', attempts: 5, avgAccuracyPercent: 80 },
        { phase: 'middlegame', attempts: 12, avgAccuracyPercent: 65 },
        { phase: 'endgame', attempts: 3, avgAccuracyPercent: 70 },
      ],
      byTheme: [
        { theme: 'mateIn1', attempts: 4, avgAccuracyPercent: 30, weakness: 70 },
        { theme: 'fork', attempts: 6, avgAccuracyPercent: 50, weakness: 50 },
      ],
    } satisfies PrecisionBreakdownsResponse);

    renderWithProviders(<PrecisionBreakdowns fetcher={fetcher} />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-breakdowns').getAttribute('data-state'),
      ).toBe('ready');
    });
    expect(
      screen.getByTestId('precision-breakdowns-phase-opening'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('precision-breakdowns-phase-middlegame'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('precision-breakdowns-phase-endgame'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('precision-breakdowns-theme-mateIn1'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('precision-breakdowns-theme-fork'),
    ).toBeTruthy();
  });

  it('пустой byPhase + byTheme → empty-state', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      byPhase: [],
      byTheme: [],
    } satisfies PrecisionBreakdownsResponse);

    renderWithProviders(<PrecisionBreakdowns fetcher={fetcher} />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-breakdowns').getAttribute('data-state'),
      ).toBe('empty');
    });
    expect(screen.getByTestId('precision-breakdowns-empty')).toBeTruthy();
  });

  it('ошибка fetch → error-state с retry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('500'));
    renderWithProviders(<PrecisionBreakdowns fetcher={fetcher} />);
    await waitFor(() => {
      expect(
        screen.getByTestId('precision-breakdowns').getAttribute('data-state'),
      ).toBe('error');
    });
    expect(screen.getByTestId('precision-breakdowns-retry')).toBeTruthy();
  });
});
