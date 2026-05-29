import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  BoardSettingsProvider,
  useBoardSettingsContext,
} from './BoardSettingsContext';

/**
 * KS-2970 — unit на новое поле `autoPromoteToQueen` контекста настроек
 * доски: default `false`, set/persist в localStorage, корректное
 * восстановление при следующем монтировании Provider'а.
 */

const LS_KEY = 'autoPromoteToQueen';

beforeEach(() => {
  localStorage.clear();
});

describe('BoardSettingsContext.autoPromoteToQueen (KS-2970)', () => {
  it('default value is false', () => {
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    expect(result.current.autoPromoteToQueen).toBe(false);
  });

  it('setAutoPromoteToQueen(true) обновляет state и пишет в localStorage', () => {
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    act(() => {
      result.current.setAutoPromoteToQueen(true);
    });
    expect(result.current.autoPromoteToQueen).toBe(true);
    expect(localStorage.getItem(LS_KEY)).toBe('true');
  });

  it('setAutoPromoteToQueen(false) пишет "false" в localStorage', () => {
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    act(() => {
      result.current.setAutoPromoteToQueen(true);
    });
    act(() => {
      result.current.setAutoPromoteToQueen(false);
    });
    expect(result.current.autoPromoteToQueen).toBe(false);
    expect(localStorage.getItem(LS_KEY)).toBe('false');
  });

  it('значение из localStorage восстанавливается при следующем mount', () => {
    localStorage.setItem(LS_KEY, 'true');
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    expect(result.current.autoPromoteToQueen).toBe(true);
  });

  it('мусорное значение в localStorage не ломает default (остаётся false)', () => {
    localStorage.setItem(LS_KEY, 'garbage');
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    // readAutoPromoteToQueen сравнивает строкой с 'true' → 'garbage' → false.
    expect(result.current.autoPromoteToQueen).toBe(false);
  });
});

/**
 * KS-3415 — интервал авто-перемотки теперь хранится в МС (ползунок),
 * не preset-id. Default 150, клемп [50..500], persist в тот же ключ
 * `navAutoRepeatSpeed`, backward-compat миграция старых preset-id.
 */
const LS_NAV_KEY = 'navAutoRepeatSpeed';

describe('BoardSettingsContext.navAutoRepeatMs (KS-3415)', () => {
  it('default = 150 мс', () => {
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    expect(result.current.navAutoRepeatMs).toBe(150);
  });

  it('setNavAutoRepeatMs пишет число в localStorage и обновляет state', () => {
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    act(() => {
      result.current.setNavAutoRepeatMs(75);
    });
    expect(result.current.navAutoRepeatMs).toBe(75);
    expect(localStorage.getItem(LS_NAV_KEY)).toBe('75');
  });

  it('setNavAutoRepeatMs клемпит к диапазону [50..500]', () => {
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    act(() => result.current.setNavAutoRepeatMs(10));
    expect(result.current.navAutoRepeatMs).toBe(50);
    act(() => result.current.setNavAutoRepeatMs(9999));
    expect(result.current.navAutoRepeatMs).toBe(500);
  });

  it('backward-compat: legacy preset-id мапится в intervalMs', () => {
    localStorage.setItem(LS_NAV_KEY, 'slow'); // 250 мс
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    expect(result.current.navAutoRepeatMs).toBe(250);
  });

  it('числовое значение из localStorage восстанавливается (с клемпом)', () => {
    localStorage.setItem(LS_NAV_KEY, '300');
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    expect(result.current.navAutoRepeatMs).toBe(300);
  });

  it('мусор в localStorage → default 150', () => {
    localStorage.setItem(LS_NAV_KEY, 'garbage');
    const { result } = renderHook(() => useBoardSettingsContext(), {
      wrapper: BoardSettingsProvider,
    });
    expect(result.current.navAutoRepeatMs).toBe(150);
  });
});
