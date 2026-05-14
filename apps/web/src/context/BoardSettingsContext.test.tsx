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
