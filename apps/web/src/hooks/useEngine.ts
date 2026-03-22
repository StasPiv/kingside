import { useMemo } from 'react';
import { useStockfish } from './useStockfish';
import { useExternalEngine } from './useExternalEngine';
import type { ExternalEngineConfig } from './useExternalEngine';
import type { EvalLine } from './useStockfish';

export type EngineSource = 'wasm' | 'external';

type UseEngineOptions = {
  source: EngineSource;
  externalConfig: ExternalEngineConfig | null;
  depth?: number;
  multiPv?: number;
  autoStart?: boolean;
};

type EngineResult = {
  state: string;
  lines: EvalLine[];
  analysisFen: string | null;
  bestMove: string | null;
  evaluate: (fen: string) => void;
  stop: () => void;
  setOption: (name: string, value: string) => void;
  init: () => void;
  cleanup: () => void;
  isReady: boolean;
  engineName: string;
  engineSource: EngineSource;
  errorMessage: string | null;
};

const STORAGE_KEY = 'externalEngineConfigs';

/** Load saved engine configs from localStorage */
export function loadEngineConfigs(): ExternalEngineConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Save engine configs to localStorage */
export function saveEngineConfigs(configs: ExternalEngineConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

/**
 * Unified engine hook — wraps useStockfish and useExternalEngine.
 * Switches based on `source` parameter.
 */
export function useEngine(options: UseEngineOptions): EngineResult {
  const { source, externalConfig, depth = 20, multiPv = 3, autoStart = true } = options;

  const wasm = useStockfish({
    depth,
    multiPv,
  });

  const external = useExternalEngine({
    config: source === 'external' ? externalConfig : null,
    depth,
    multiPv,
    autoStart: autoStart && source === 'external',
  });

  return useMemo(() => {
    if (source === 'external') {
      return {
        state: external.state,
        lines: external.lines,
        analysisFen: external.analysisFen,
        bestMove: external.bestMove,
        evaluate: external.evaluate,
        stop: external.stop,
        setOption: external.setOption,
        init: external.init,
        cleanup: external.cleanup,
        isReady: external.isReady,
        engineName: externalConfig?.name || external.engineName,
        engineSource: 'external' as const,
        errorMessage: external.errorMessage,
      };
    }

    return {
      state: wasm.state,
      lines: wasm.lines,
      analysisFen: wasm.analysisFen,
      bestMove: wasm.bestMove,
      evaluate: wasm.evaluate,
      stop: wasm.stop,
      setOption: () => {},
      init: wasm.init,
      cleanup: wasm.cleanup,
      isReady: wasm.isReady,
      engineName: 'Stockfish 18 (WASM)',
      engineSource: 'wasm' as const,
      errorMessage: null,
    };
  }, [source, wasm, external]);
}
