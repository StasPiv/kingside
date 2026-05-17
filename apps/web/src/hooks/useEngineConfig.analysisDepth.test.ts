/**
 * KS-3085: тесты для `analysisDepth` state в `useEngineConfig`.
 * Покрываем:
 *  - default = 18 (точка калибровки WDL, не менять);
 *  - кламп <10 → 10, >30 → 30;
 *  - округление к целому (на случай дробных значений из слайдера);
 *  - персистентность через localStorage `analysisDepth`;
 *  - игнор битого/невалидного значения в localStorage.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEngineConfig } from './useEngineConfig';

describe('useEngineConfig.analysisDepth (KS-3085)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('default = 18 если localStorage пуст', () => {
    const { result } = renderHook(() => useEngineConfig());
    expect(result.current.analysisDepth).toBe(18);
    expect(result.current.defaultAnalysisDepth).toBe(18);
    expect(result.current.minAnalysisDepth).toBe(10);
    expect(result.current.maxAnalysisDepth).toBe(30);
  });

  it('значение 25 сохраняется в state и в localStorage', () => {
    const { result } = renderHook(() => useEngineConfig());
    act(() => {
      result.current.setAnalysisDepth(25);
    });
    expect(result.current.analysisDepth).toBe(25);
    expect(localStorage.getItem('analysisDepth')).toBe('25');
  });

  it('кламп ниже минимума (10): setAnalysisDepth(5) → 10', () => {
    const { result } = renderHook(() => useEngineConfig());
    act(() => {
      result.current.setAnalysisDepth(5);
    });
    expect(result.current.analysisDepth).toBe(10);
    expect(localStorage.getItem('analysisDepth')).toBe('10');
  });

  it('кламп выше максимума (30): setAnalysisDepth(99) → 30', () => {
    const { result } = renderHook(() => useEngineConfig());
    act(() => {
      result.current.setAnalysisDepth(99);
    });
    expect(result.current.analysisDepth).toBe(30);
  });

  it('округление дробных значений (от range-input)', () => {
    const { result } = renderHook(() => useEngineConfig());
    act(() => {
      result.current.setAnalysisDepth(22.7);
    });
    expect(result.current.analysisDepth).toBe(23);
  });

  it('восстанавливается из localStorage при mount', () => {
    localStorage.setItem('analysisDepth', '24');
    const { result } = renderHook(() => useEngineConfig());
    expect(result.current.analysisDepth).toBe(24);
  });

  it('битое значение в localStorage → fallback на default 18', () => {
    localStorage.setItem('analysisDepth', 'not-a-number');
    const { result } = renderHook(() => useEngineConfig());
    expect(result.current.analysisDepth).toBe(18);
  });

  it('значение вне диапазона в localStorage → fallback на default 18', () => {
    localStorage.setItem('analysisDepth', '500');
    const { result } = renderHook(() => useEngineConfig());
    expect(result.current.analysisDepth).toBe(18);
  });

  it('функциональный апдейтер: setAnalysisDepth((prev) => prev + 2)', () => {
    const { result } = renderHook(() => useEngineConfig());
    act(() => {
      result.current.setAnalysisDepth((prev) => prev + 2);
    });
    expect(result.current.analysisDepth).toBe(20);
  });
});
