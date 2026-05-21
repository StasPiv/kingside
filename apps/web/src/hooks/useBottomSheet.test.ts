import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useBottomSheet } from './useBottomSheet';

/**
 * KS-3190 (ADR-073 §7 F3): юнит-тесты `useBottomSheet`. Pointer-event'ы
 * имитируем минимальным mock'ом (только нужные поля). jsdom не умеет
 * setPointerCapture — соответствующий try/catch внутри хука это
 * гасит, тест получает корректное поведение.
 */

function mkPointerEvent(over: Partial<PointerEvent> = {}): React.PointerEvent<HTMLElement> {
  return {
    clientY: 0,
    pointerId: 1,
    target: { setPointerCapture: () => undefined } as unknown as Element,
    ...over,
  } as unknown as React.PointerEvent<HTMLElement>;
}

describe('useBottomSheet (KS-3190)', () => {
  it('по умолчанию snap=peek', () => {
    const { result } = renderHook(() => useBottomSheet());
    expect(result.current.snap).toBe('peek');
  });

  it('setSnap меняет snap (peek → full)', () => {
    const { result } = renderHook(() => useBottomSheet());
    act(() => result.current.setSnap('full'));
    expect(result.current.snap).toBe('full');
  });

  it('cycleSnap проходит peek → half → full → peek', () => {
    const { result } = renderHook(() => useBottomSheet());
    expect(result.current.snap).toBe('peek');
    act(() => result.current.cycleSnap());
    expect(result.current.snap).toBe('half');
    act(() => result.current.cycleSnap());
    expect(result.current.snap).toBe('full');
    act(() => result.current.cycleSnap());
    expect(result.current.snap).toBe('peek');
  });

  it('swipe up (drag вверх > 24px) переключает на следующий snap вверх', () => {
    const { result } = renderHook(() => useBottomSheet());
    // pointerdown на y=200
    act(() =>
      result.current.handleProps.onPointerDown(
        mkPointerEvent({ clientY: 200 }),
      ),
    );
    // pointerup на y=160 (40px вверх). snap: peek → half.
    act(() =>
      result.current.handleProps.onPointerUp(mkPointerEvent({ clientY: 160 })),
    );
    expect(result.current.snap).toBe('half');
  });

  it('swipe down (drag вниз > 24px) переключает на следующий snap вниз', () => {
    const { result } = renderHook(() => useBottomSheet({ initial: 'full' }));
    act(() =>
      result.current.handleProps.onPointerDown(
        mkPointerEvent({ clientY: 100 }),
      ),
    );
    act(() =>
      result.current.handleProps.onPointerUp(mkPointerEvent({ clientY: 160 })),
    );
    // full → half
    expect(result.current.snap).toBe('half');
  });

  it('tap (delta ≤ 24px) циклически переключает snap (peek → half)', () => {
    const { result } = renderHook(() => useBottomSheet());
    act(() =>
      result.current.handleProps.onPointerDown(
        mkPointerEvent({ clientY: 100 }),
      ),
    );
    act(() =>
      result.current.handleProps.onPointerUp(mkPointerEvent({ clientY: 105 })),
    );
    expect(result.current.snap).toBe('half');
  });

  it('swipe вверх из full остаётся full (нет точки выше)', () => {
    const { result } = renderHook(() => useBottomSheet({ initial: 'full' }));
    act(() =>
      result.current.handleProps.onPointerDown(
        mkPointerEvent({ clientY: 200 }),
      ),
    );
    act(() =>
      result.current.handleProps.onPointerUp(mkPointerEvent({ clientY: 100 })),
    );
    expect(result.current.snap).toBe('full');
  });

  it('swipe вниз из peek остаётся peek (нет точки ниже)', () => {
    const { result } = renderHook(() => useBottomSheet({ initial: 'peek' }));
    act(() =>
      result.current.handleProps.onPointerDown(
        mkPointerEvent({ clientY: 100 }),
      ),
    );
    act(() =>
      result.current.handleProps.onPointerUp(mkPointerEvent({ clientY: 200 })),
    );
    expect(result.current.snap).toBe('peek');
  });

  it('onPointerCancel сбрасывает активный drag (pointerup после cancel не двигает)', () => {
    const { result } = renderHook(() => useBottomSheet());
    act(() =>
      result.current.handleProps.onPointerDown(
        mkPointerEvent({ clientY: 200 }),
      ),
    );
    act(() => result.current.handleProps.onPointerCancel());
    act(() =>
      result.current.handleProps.onPointerUp(mkPointerEvent({ clientY: 100 })),
    );
    expect(result.current.snap).toBe('peek');
  });
});
