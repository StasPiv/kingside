import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useLongPress } from './useLongPress';

/**
 * KS-3198: useLongPress тестирует поведение, описанное в задаче §1-§5
 * (warm-up задержка, авто-tick'и, остановка по pointerup / disabled,
 * cleanup на unmount).
 *
 * Pointer events эмулируем минимальным объектом — useLongPress читает
 * только `pointerType` и `button`, поэтому полную имплементацию
 * PointerEvent создавать не нужно.
 */
function ptr(opts: Partial<{ pointerType: string; button: number }> = {}) {
  return {
    pointerType: 'touch',
    button: 0,
    ...opts,
  } as React.PointerEvent<HTMLElement>;
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('не вызывает onAction до истечения warmUpDelay (короткий tap → нет авто)', () => {
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onAction, warmUpDelay: 350, tickInterval: 150 }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
    });
    // Отпустили через 100ms — короткий tap, авто не должен запуститься.
    act(() => {
      vi.advanceTimersByTime(100);
      result.current.onPointerUp(ptr());
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('после warmUpDelay вызывает onAction сразу, потом каждые tickInterval', () => {
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onAction, warmUpDelay: 350, tickInterval: 150 }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
    });
    // До warm-up — пусто.
    act(() => vi.advanceTimersByTime(349));
    expect(onAction).toHaveBeenCalledTimes(0);

    // Прошёл warm-up — первый tick.
    act(() => vi.advanceTimersByTime(1));
    expect(onAction).toHaveBeenCalledTimes(1);

    // Дальше каждые 150ms.
    act(() => vi.advanceTimersByTime(150));
    expect(onAction).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(300));
    expect(onAction).toHaveBeenCalledTimes(4);
  });

  it('pointerup останавливает авто-повтор', () => {
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onAction, warmUpDelay: 350, tickInterval: 150 }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(500); // warm-up + 1 tick
    });
    expect(onAction).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.onPointerUp(ptr());
      vi.advanceTimersByTime(1000); // 1 секунда после release
    });
    // Никаких новых вызовов после release.
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('pointerleave и pointercancel тоже останавливают', () => {
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onAction, warmUpDelay: 350, tickInterval: 150 }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(500);
    });
    expect(onAction).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.onPointerLeave(ptr());
      vi.advanceTimersByTime(500);
    });
    expect(onAction).toHaveBeenCalledTimes(2);

    // Второй цикл — pointercancel
    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(500);
    });
    expect(onAction).toHaveBeenCalledTimes(4);
    act(() => {
      result.current.onPointerCancel(ptr());
      vi.advanceTimersByTime(500);
    });
    expect(onAction).toHaveBeenCalledTimes(4);
  });

  it('disabled=true игнорирует pointerdown полностью', () => {
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({
        onAction,
        warmUpDelay: 350,
        tickInterval: 150,
        disabled: true,
      }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(2000);
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('disabled→true во время активного повтора немедленно останавливает', () => {
    const onAction = vi.fn();
    const { result, rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) =>
        useLongPress({
          onAction,
          warmUpDelay: 350,
          tickInterval: 150,
          disabled,
        }),
      { initialProps: { disabled: false } },
    );

    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(500);
    });
    expect(onAction).toHaveBeenCalledTimes(2);

    // Симулируем «доехали до конца партии» — disabled стал true.
    rerender({ disabled: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('игнорирует правую кнопку мыши (button !== 0)', () => {
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onAction, warmUpDelay: 350, tickInterval: 150 }),
    );

    act(() => {
      result.current.onPointerDown(ptr({ pointerType: 'mouse', button: 2 }));
      vi.advanceTimersByTime(2000);
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('cleanup на unmount — таймеры не остаются', () => {
    const onAction = vi.fn();
    const { result, unmount } = renderHook(() =>
      useLongPress({ onAction, warmUpDelay: 350, tickInterval: 150 }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(500);
    });
    expect(onAction).toHaveBeenCalledTimes(2);

    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('haptic=true дёргает navigator.vibrate на каждом tick', () => {
    const vibrate = vi.fn();
    (navigator as unknown as { vibrate?: (n: number) => void }).vibrate =
      vibrate;
    const onAction = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({
        onAction,
        warmUpDelay: 350,
        tickInterval: 150,
        haptic: true,
      }),
    );

    act(() => {
      result.current.onPointerDown(ptr());
      vi.advanceTimersByTime(500); // warm-up + 1 tick
    });
    expect(vibrate).toHaveBeenCalledTimes(2);

    delete (navigator as unknown as { vibrate?: unknown }).vibrate;
  });
});
