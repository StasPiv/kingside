import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useAutoSave } from './useAutoSave';

/**
 * KS-1850 (FE-R2): тесты `useAutoSave`.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoSave', () => {
  it('дефолт: status=idle, lastSavedAt=null, error=null', () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ saveFn }));
    expect(result.current.status).toBe('idle');
    expect(result.current.lastSavedAt).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('save() → debounce 500мс, один saveFn с последним payload', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ saveFn }));
    act(() => result.current.save({ v: 1 }));
    act(() => result.current.save({ v: 2 }));
    act(() => result.current.save({ v: 3 }));

    // До 500мс saveFn не вызван
    vi.advanceTimersByTime(400);
    expect(saveFn).not.toHaveBeenCalled();

    // После 500мс — один вызов с последним payload
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith({ v: 3 });
  });

  it('saveFn успех → status переходит idle → saving → saved + lastSavedAt', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ saveFn }));
    act(() => result.current.save({ x: 1 }));

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(result.current.status).toBe('saved');
    expect(result.current.lastSavedAt).toBeInstanceOf(Date);
    expect(result.current.error).toBeNull();
  });

  it('saveFn ошибка → status=error, error=Error, lastSavedAt не обновляется', async () => {
    const err = new Error('boom');
    const saveFn = vi.fn().mockRejectedValue(err);
    const { result } = renderHook(() => useAutoSave({ saveFn }));
    act(() => result.current.save({ x: 1 }));
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(err);
    expect(result.current.lastSavedAt).toBeNull();
  });

  it('retry() повторяет последний payload; успех после ошибки → status=saved', async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAutoSave({ saveFn }));
    act(() => result.current.save({ n: 42 }));
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('error');

    await act(async () => {
      result.current.retry();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('saved');
    // retry использует последний payload
    expect(saveFn).toHaveBeenNthCalledWith(2, { n: 42 });
  });

  it('flush() отправляет отложенный save немедленно, не ждёт таймер', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ saveFn }));
    act(() => result.current.save({ k: 'v' }));
    // До flush — saveFn не вызван
    expect(saveFn).not.toHaveBeenCalled();
    await act(async () => {
      result.current.flush();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith({ k: 'v' });
    // Таймер не должен выстрелить повторно
    vi.advanceTimersByTime(1000);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('unmount отменяет pending таймер (нет set-state на исчезнувшем компоненте)', () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoSave({ saveFn }));
    act(() => result.current.save({ v: 1 }));
    unmount();
    vi.advanceTimersByTime(1000);
    // saveFn НЕ должен вызываться после unmount
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('кастомный delayMs: 100мс — saveFn вызывается через 100мс', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutoSave({ saveFn, delayMs: 100 }),
    );
    act(() => result.current.save({ v: 1 }));
    vi.advanceTimersByTime(80);
    expect(saveFn).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });
});
