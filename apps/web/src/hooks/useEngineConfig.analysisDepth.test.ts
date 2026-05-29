/**
 * KS-3404: ползунок «Максимальная глубина анализа» и тумблер «Без
 * ограничения глубины» убраны — окно анализа всегда идёт бесконечно
 * (go infinite). Конфиг `analysisDepth`/`analysisUnlimited` удалён из
 * `useEngineConfig`. Этот тест — регресс-гард: хук больше НЕ отдаёт эти
 * поля (раньше тут были тесты KS-3085 на клемп/персист depth).
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEngineConfig } from './useEngineConfig';

describe('useEngineConfig — KS-3404 depth-config removed', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('хук не отдаёт analysisDepth/analysisUnlimited (анализ всегда infinite)', () => {
    const { result } = renderHook(() => useEngineConfig());
    const cfg = result.current as Record<string, unknown>;
    expect('analysisDepth' in cfg).toBe(false);
    expect('setAnalysisDepth' in cfg).toBe(false);
    expect('minAnalysisDepth' in cfg).toBe(false);
    expect('maxAnalysisDepth' in cfg).toBe(false);
    expect('defaultAnalysisDepth' in cfg).toBe(false);
    expect('analysisUnlimited' in cfg).toBe(false);
    expect('setAnalysisUnlimited' in cfg).toBe(false);
  });

  it('multiPv по-прежнему доступен (не задет очисткой)', () => {
    const { result } = renderHook(() => useEngineConfig());
    expect(typeof result.current.multiPv).toBe('number');
    expect(typeof result.current.setMultiPv).toBe('function');
  });
});
