import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { SaveStatusPill } from './SaveStatusPill';

/**
 * KS-1850 (FE-R2): `SaveStatusPill` — 4 состояния + retry.
 */

describe('<SaveStatusPill>', () => {
  it('status=idle → показывает label idle, data-status=idle', () => {
    renderWithProviders(<SaveStatusPill status="idle" />);
    const pill = screen.getByTestId('save-status-pill');
    expect(pill.getAttribute('data-status')).toBe('idle');
    expect(screen.getByTestId('save-status-pill-idle')).toBeInTheDocument();
    expect(
      screen.queryByTestId('save-status-pill-spinner'),
    ).not.toBeInTheDocument();
  });

  it('status=saving → показывает spinner + label saving', () => {
    renderWithProviders(<SaveStatusPill status="saving" />);
    expect(screen.getByTestId('save-status-pill-spinner')).toBeInTheDocument();
    expect(screen.getByTestId('save-status-pill-saving')).toBeInTheDocument();
  });

  it('status=saved + lastSavedAt → показывает «Saved at HH:MM»', () => {
    const d = new Date(2026, 3, 24, 9, 7); // 09:07
    renderWithProviders(<SaveStatusPill status="saved" lastSavedAt={d} />);
    const label = screen.getByTestId('save-status-pill-saved');
    expect(label.textContent).toMatch(/09:07/);
  });

  it('status=saved без lastSavedAt → показывает «Saved» без timestamp', () => {
    renderWithProviders(<SaveStatusPill status="saved" />);
    const label = screen.getByTestId('save-status-pill-saved');
    expect(label.textContent).not.toMatch(/\d\d:\d\d/);
  });

  it('status=error + onRetry → есть кнопка retry, клик вызывает колбэк', () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <SaveStatusPill status="error" onRetry={onRetry} />,
    );
    expect(screen.getByTestId('save-status-pill-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('save-status-pill-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('status=error без onRetry → кнопка retry не рендерится', () => {
    renderWithProviders(<SaveStatusPill status="error" />);
    expect(screen.getByTestId('save-status-pill-error')).toBeInTheDocument();
    expect(
      screen.queryByTestId('save-status-pill-retry'),
    ).not.toBeInTheDocument();
  });

  it('role=status + aria-live=polite — screen reader анонсирует смены', () => {
    renderWithProviders(<SaveStatusPill status="saving" />);
    const pill = screen.getByTestId('save-status-pill');
    expect(pill.getAttribute('role')).toBe('status');
    expect(pill.getAttribute('aria-live')).toBe('polite');
  });

  it('класс меняется под state — для snapshot в L-R7', () => {
    const { rerender } = renderWithProviders(
      <SaveStatusPill status="idle" />,
    );
    expect(screen.getByTestId('save-status-pill').className).toContain(
      'save-status-pill--idle',
    );
    rerender(<SaveStatusPill status="saving" />);
    expect(screen.getByTestId('save-status-pill').className).toContain(
      'save-status-pill--saving',
    );
    rerender(<SaveStatusPill status="saved" />);
    expect(screen.getByTestId('save-status-pill').className).toContain(
      'save-status-pill--saved',
    );
    rerender(<SaveStatusPill status="error" />);
    expect(screen.getByTestId('save-status-pill').className).toContain(
      'save-status-pill--error',
    );
  });
});
