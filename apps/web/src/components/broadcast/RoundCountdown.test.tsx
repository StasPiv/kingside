import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { renderWithProviders } from '../../test/test-utils';
import { RoundCountdown } from './RoundCountdown';

/**
 * KS-4848 / ADR-158 §2.4.1: countdown с прогрессивной детализацией.
 * Тестируем ветки по расстоянию до `startsAt` и behaviour при `null`.
 */

function renderWithI18n(node: React.ReactElement) {
  return renderWithProviders(node);
}

beforeEach(() => {
  vi.useFakeTimers();
  // 2026-07-06T12:00:00Z — фиксированное «сейчас».
  vi.setSystemTime(new Date('2026-07-06T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoundCountdown (KS-4848)', () => {
  it('startsAt=null → «Start time not announced»', () => {
    renderWithI18n(<RoundCountdown startsAt={null} />);
    const el = screen.getByTestId('broadcast-countdown');
    expect(el).toHaveAttribute('data-countdown-state', 'unknown');
    expect(el.textContent).toMatch(/announced/i);
  });

  it('startsAt в прошлом → overdue-текст с временем', () => {
    // За 10 минут до «сейчас».
    const startsAt = new Date('2026-07-06T11:50:00.000Z').toISOString();
    renderWithI18n(<RoundCountdown startsAt={startsAt} />);
    const el = screen.getByTestId('broadcast-countdown');
    expect(el).toHaveAttribute('data-countdown-state', 'overdue');
    expect(el.textContent).toMatch(/awaiting/i);
  });

  it('> 24 часов → абсолютная дата', () => {
    // Через 3 дня.
    const startsAt = new Date('2026-07-09T14:00:00.000Z').toISOString();
    renderWithI18n(<RoundCountdown startsAt={startsAt} />);
    const el = screen.getByTestId('broadcast-countdown');
    expect(el).toHaveAttribute('data-countdown-state', 'far');
    expect(el.textContent).toMatch(/Starts/i);
  });

  it('1..24 часа → «In H h M min»', () => {
    // Через 3 часа 15 минут.
    const startsAt = new Date('2026-07-06T15:15:00.000Z').toISOString();
    renderWithI18n(<RoundCountdown startsAt={startsAt} />);
    const el = screen.getByTestId('broadcast-countdown');
    expect(el).toHaveAttribute('data-countdown-state', 'medium');
    expect(el.textContent).toMatch(/3\s*h/i);
    expect(el.textContent).toMatch(/15\s*min/i);
  });

  it('5м..1ч → «In N min»', () => {
    // Через 20 минут.
    const startsAt = new Date('2026-07-06T12:20:00.000Z').toISOString();
    renderWithI18n(<RoundCountdown startsAt={startsAt} />);
    const el = screen.getByTestId('broadcast-countdown');
    expect(el).toHaveAttribute('data-countdown-state', 'near');
    expect(el.textContent).toMatch(/20/);
  });

  it('0..5м → «In MM:SS» и tickает каждую секунду', () => {
    // Через 2 минуты 30 секунд.
    const startsAt = new Date('2026-07-06T12:02:30.000Z').toISOString();
    renderWithI18n(<RoundCountdown startsAt={startsAt} />);
    const el = screen.getByTestId('broadcast-countdown');
    expect(el).toHaveAttribute('data-countdown-state', 'imminent');
    expect(el.textContent).toMatch(/02:30/);

    // Прокрутим таймер на 1 секунду — MM:SS должно уменьшиться.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('broadcast-countdown').textContent).toMatch(
      /02:29/,
    );
  });
});
