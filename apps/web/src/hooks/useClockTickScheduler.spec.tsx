/**
 * KS-4654 / ADR-144 §3.6 — тесты планировщика метронома часов.
 *
 * Не разогреваем настоящий AudioContext, не покрываем здесь синтез
 * клика — за это отвечает `useSounds.ts` сам. Здесь убеждаемся, что
 * `useSounds.playSound('clock-tick')` дёргается с правильной частотой
 * и в правильных условиях: `useSounds` мокается, проверяем число
 * вызовов под fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const playSoundMock = vi.fn();
vi.mock('./useSounds', () => ({
  useSounds: () => ({
    playSound: playSoundMock,
    muted: false,
    toggleMute: vi.fn(),
    theme: 'standard' as const,
    setTheme: vi.fn(),
    unlocked: true,
    unlockSounds: vi.fn(),
  }),
}));

import { useClockTickScheduler } from './useClockTickScheduler';
import type { ClockUrgency } from '../utils/formatGameClock';

describe('useClockTickScheduler — KS-4654', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    playSoundMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isSelfActive=false → playSound не вызывается ни разу', () => {
    renderHook(() =>
      useClockTickScheduler({ urgency: 'critical', isSelfActive: false }),
    );
    vi.advanceTimersByTime(5_000);
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it('urgency=normal → playSound не вызывается даже если isSelfActive', () => {
    renderHook(() =>
      useClockTickScheduler({ urgency: 'normal', isSelfActive: true }),
    );
    vi.advanceTimersByTime(5_000);
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  it('urgency=low + isSelfActive → тикает каждую секунду', () => {
    renderHook(() =>
      useClockTickScheduler({ urgency: 'low', isSelfActive: true }),
    );
    vi.advanceTimersByTime(999);
    expect(playSoundMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(playSoundMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(playSoundMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3_000);
    expect(playSoundMock).toHaveBeenCalledTimes(5);
  });

  it('urgency=critical + isSelfActive → тикает каждые 500 мс', () => {
    renderHook(() =>
      useClockTickScheduler({ urgency: 'critical', isSelfActive: true }),
    );
    vi.advanceTimersByTime(499);
    expect(playSoundMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(playSoundMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(playSoundMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    // Через 3 секунды от старта — 6 тиков.
    expect(playSoundMock).toHaveBeenCalledTimes(6);
  });

  it('low → critical: частота переключается без задвоения', () => {
    const { rerender } = renderHook(
      (props: { urgency: ClockUrgency; isSelfActive: boolean }) =>
        useClockTickScheduler(props),
      { initialProps: { urgency: 'low', isSelfActive: true } },
    );
    vi.advanceTimersByTime(2_500); // 2 тика low
    expect(playSoundMock).toHaveBeenCalledTimes(2);

    rerender({ urgency: 'critical', isSelfActive: true });
    // Новый интервал стартует с момента rerender; через 500 мс — ещё 1.
    vi.advanceTimersByTime(500);
    expect(playSoundMock).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(500);
    expect(playSoundMock).toHaveBeenCalledTimes(4);
  });

  it('критический → normal: тик останавливается', () => {
    const { rerender } = renderHook(
      (props: { urgency: ClockUrgency; isSelfActive: boolean }) =>
        useClockTickScheduler(props),
      { initialProps: { urgency: 'critical', isSelfActive: true } },
    );
    vi.advanceTimersByTime(500);
    expect(playSoundMock).toHaveBeenCalledTimes(1);

    rerender({ urgency: 'normal', isSelfActive: true });
    vi.advanceTimersByTime(5_000);
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it('low: ход уходит сопернику (isSelfActive=false) → тик прекращается', () => {
    const { rerender } = renderHook(
      (props: { urgency: ClockUrgency; isSelfActive: boolean }) =>
        useClockTickScheduler(props),
      { initialProps: { urgency: 'low', isSelfActive: true } },
    );
    vi.advanceTimersByTime(1_000);
    expect(playSoundMock).toHaveBeenCalledTimes(1);

    rerender({ urgency: 'low', isSelfActive: false });
    vi.advanceTimersByTime(5_000);
    // Тик прекратился — счётчик не вырос.
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  it('размонтирование → интервал очищается', () => {
    const { unmount } = renderHook(() =>
      useClockTickScheduler({ urgency: 'critical', isSelfActive: true }),
    );
    vi.advanceTimersByTime(500);
    expect(playSoundMock).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(5_000);
    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });
});
