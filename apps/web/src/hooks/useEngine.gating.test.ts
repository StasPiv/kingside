/**
 * KS-3908 / ADR-117 C04. Тесты гейтинга `useEngine`.
 *
 * Цель — убедиться, что при `enabled=false`:
 *  - `useStockfish` получает `autoStart=false` (WASM-воркер не
 *    инициализируется ни через autoStart, ни через `init()`/`evaluate()`);
 *  - `useExternalEngine` получает `config=null` и `autoStart=false`
 *    (external bridge не подключается);
 *  - возвращённые `evaluate`/`stop`/`init`/`cleanup`/`setOption` — no-op;
 *  - `lines = []`, `isReady=false`, `supportsSearchmoves=false`.
 *
 * Заодно — sanity-check, что при `enabled=true` (default) поведение
 * прежнее: подлежащие хуки получают пробрасываемые параметры.
 */

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Моки внутренних хуков. Подменяем до import {useEngine} так, чтобы
// внутри обёртки реальные `useStockfish`/`useExternalEngine` не
// дёргались. `vi.fn()` фиксирует вызовы и аргументы.
const useStockfishMock = vi.fn((_opts: unknown) => ({
  state: 'idle',
  lines: [],
  analysisFen: null,
  bestMove: null,
  evaluate: vi.fn(),
  stop: vi.fn(),
  init: vi.fn(),
  cleanup: vi.fn(),
  isReady: false,
  loadProgress: 0,
  errorReason: null,
}));
const useExternalEngineMock = vi.fn((_opts: unknown) => ({
  state: 'idle',
  lines: [],
  analysisFen: null,
  bestMove: null,
  evaluate: vi.fn(),
  stop: vi.fn(),
  setOption: vi.fn(),
  init: vi.fn(),
  cleanup: vi.fn(),
  isReady: false,
  engineName: 'External',
  errorMessage: null,
}));

vi.mock('./useStockfish', () => ({
  useStockfish: (opts: unknown) => useStockfishMock(opts),
}));
vi.mock('./useExternalEngine', () => ({
  useExternalEngine: (opts: unknown) => useExternalEngineMock(opts),
}));
// Debounce — пропускаем без задержки, чтобы первый рендер уже передал
// финальные значения в подлежащие хуки.
vi.mock('./useDebouncedValue', () => ({
  useDebouncedValue: <T,>(v: T) => v,
}));

import { useEngine } from './useEngine';

describe('useEngine — KS-3908 gating', () => {
  beforeEach(() => {
    useStockfishMock.mockClear();
    useExternalEngineMock.mockClear();
  });

  it('enabled=false → useStockfish получает autoStart=false; useExternalEngine получает config=null', () => {
    renderHook(() =>
      useEngine({
        source: 'wasm',
        externalConfig: null,
        multiPv: 3,
        enabled: false,
      }),
    );
    expect(useStockfishMock).toHaveBeenCalled();
    const sfArgs = useStockfishMock.mock.calls[0]?.[0] as {
      autoStart?: boolean;
      searchmoves?: unknown;
      infinite?: boolean;
    };
    expect(sfArgs.autoStart).toBe(false);
    expect(sfArgs.searchmoves).toBeNull();
    expect(sfArgs.infinite).toBe(false);

    const extArgs = useExternalEngineMock.mock.calls[0]?.[0] as {
      config: unknown;
      autoStart: boolean;
      searchmoves: unknown;
    };
    expect(extArgs.config).toBeNull();
    expect(extArgs.autoStart).toBe(false);
    expect(extArgs.searchmoves).toBeNull();
  });

  it('enabled=false → результат — заглушка (пустые lines, no-op evaluate/init/stop, supportsSearchmoves=false)', () => {
    const { result } = renderHook(() =>
      useEngine({
        source: 'wasm',
        externalConfig: null,
        multiPv: 3,
        enabled: false,
      }),
    );
    expect(result.current.lines).toEqual([]);
    expect(result.current.isReady).toBe(false);
    expect(result.current.bestMove).toBeNull();
    expect(result.current.supportsSearchmoves).toBe(false);
    // no-op мутаторы (не падают, ничего не делают).
    expect(() => result.current.evaluate('startpos')).not.toThrow();
    expect(() => result.current.init()).not.toThrow();
    expect(() => result.current.stop()).not.toThrow();
    expect(() => result.current.cleanup()).not.toThrow();
  });

  it('enabled=true (default) + source=wasm → useStockfish получает реальные параметры, useExternalEngine — config=null', () => {
    renderHook(() =>
      useEngine({
        source: 'wasm',
        externalConfig: null,
        multiPv: 5,
        infinite: true,
        autoStart: true,
        searchmoves: ['e2e4', 'd2d4'],
      }),
    );
    expect(useStockfishMock).toHaveBeenCalled();
    const sfArgs = useStockfishMock.mock.calls[0]?.[0] as {
      autoStart?: boolean;
      multiPv?: number;
      searchmoves?: unknown;
      infinite?: boolean;
    };
    expect(sfArgs.autoStart).toBe(true);
    expect(sfArgs.multiPv).toBe(5);
    expect(sfArgs.searchmoves).toEqual(['e2e4', 'd2d4']);
    expect(sfArgs.infinite).toBe(true);
  });

  it('enabled=true + source=external → useExternalEngine получает реальный config и autoStart=true', () => {
    const cfg = {
      name: 'My',
      wsUrl: 'wss://example.invalid',
      secretKey: '',
    };
    renderHook(() =>
      useEngine({
        source: 'external',
        externalConfig: cfg,
        multiPv: 3,
        autoStart: true,
      }),
    );
    const extArgs = useExternalEngineMock.mock.calls[0]?.[0] as {
      config: unknown;
      autoStart: boolean;
    };
    expect(extArgs.config).toEqual(cfg);
    expect(extArgs.autoStart).toBe(true);
  });
});
