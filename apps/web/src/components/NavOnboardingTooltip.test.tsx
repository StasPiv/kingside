import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';
import { NavOnboardingTooltip } from './NavOnboardingTooltip';

/**
 * KS-2814 (ADR-058 §6.7 T17): tooltip показывается один раз, после
 * dismiss больше не появляется. По окончании 7-дневного окна — не
 * показывается даже если флаг не выставлен.
 */

beforeEach(() => {
  localStorage.removeItem('ks2814NavOnboardingSeen');
  vi.useFakeTimers();
  // Внутри окна показа (deploy 2026-05-12, окно 7 дней).
  vi.setSystemTime(new Date('2026-05-13T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem('ks2814NavOnboardingSeen');
});

describe('NavOnboardingTooltip (KS-2814)', () => {
  it('первый рендер — tooltip виден', () => {
    renderWithProviders(<NavOnboardingTooltip />);
    expect(screen.getByTestId('nav-onboarding-tooltip')).toBeInTheDocument();
  });

  it('после dismiss — флаг записан в localStorage, тултип скрыт', () => {
    renderWithProviders(<NavOnboardingTooltip />);
    fireEvent.click(screen.getByTestId('nav-onboarding-tooltip-close'));
    expect(localStorage.getItem('ks2814NavOnboardingSeen')).toBe('true');
    expect(
      screen.queryByTestId('nav-onboarding-tooltip'),
    ).not.toBeInTheDocument();
  });

  it('localStorage флаг уже выставлен → тултип не показывается', () => {
    localStorage.setItem('ks2814NavOnboardingSeen', 'true');
    renderWithProviders(<NavOnboardingTooltip />);
    expect(
      screen.queryByTestId('nav-onboarding-tooltip'),
    ).not.toBeInTheDocument();
  });

  it('за пределами 7-дневного окна — тултип не показывается', () => {
    // deploy 2026-05-12 + 8 дней.
    vi.setSystemTime(new Date('2026-05-20T10:00:00.000Z'));
    renderWithProviders(<NavOnboardingTooltip />);
    expect(
      screen.queryByTestId('nav-onboarding-tooltip'),
    ).not.toBeInTheDocument();
  });
});
