/**
 * KS-4035. Тесты `useLocalStorageState`.
 *
 * Используем `renderHook` + реальный `localStorage` (jsdom).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLocalStorageState } from './useLocalStorageState';

const KEY = 'ks:test:lss';

describe('useLocalStorageState (KS-4035)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('возвращает default, если ключа в storage нет', () => {
    const { result } = renderHook(() =>
      useLocalStorageState(KEY, { a: 1, b: 2 }),
    );
    expect(result.current[0]).toEqual({ a: 1, b: 2 });
  });

  it('пишет в localStorage при изменении значения', () => {
    const { result } = renderHook(() =>
      useLocalStorageState<number>(KEY, 0),
    );
    act(() => result.current[1](42));
    expect(window.localStorage.getItem(KEY)).toBe('42');
  });

  it('восстанавливает значение при повторном монтировании', () => {
    const first = renderHook(() =>
      useLocalStorageState<{ a: number; b: number }>(KEY, { a: 0, b: 0 }),
    );
    act(() => first.result.current[1]({ a: 5, b: 7 }));
    first.unmount();
    const second = renderHook(() =>
      useLocalStorageState<{ a: number; b: number }>(KEY, { a: 0, b: 0 }),
    );
    expect(second.result.current[0]).toEqual({ a: 5, b: 7 });
  });

  it('merge: новые поля из default подставляются, если в saved их нет', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ a: 5 }));
    const { result } = renderHook(() =>
      useLocalStorageState<{ a: number; b: number; c: number }>(
        KEY,
        { a: 0, b: 99, c: 100 },
        { merge: (saved, defaults) => ({ ...defaults, ...saved }) },
      ),
    );
    expect(result.current[0]).toEqual({ a: 5, b: 99, c: 100 });
  });

  it('битый JSON — фолбэк на default, ошибка не выбрасывается', () => {
    window.localStorage.setItem(KEY, '{ not json');
    const { result } = renderHook(() =>
      useLocalStorageState(KEY, { a: 1 }),
    );
    expect(result.current[0]).toEqual({ a: 1 });
  });

  it('функциональный setter (prev => next) работает и пишет в storage', () => {
    const { result } = renderHook(() =>
      useLocalStorageState<number>(KEY, 1),
    );
    act(() => result.current[1]((prev) => prev + 10));
    expect(result.current[0]).toBe(11);
    expect(window.localStorage.getItem(KEY)).toBe('11');
  });
});
