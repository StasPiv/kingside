import { useMemo } from 'react';
import { useStockfish } from './useStockfish';
import { useExternalEngine } from './useExternalEngine';
import { useDebouncedValue } from './useDebouncedValue';
import type { ExternalEngineConfig } from './useExternalEngine';
import type { EvalLine, EngineErrorReason } from './useStockfish';

/**
 * KS-3112: задержка перед отправкой смены MultiPV/depth в engine. UI-state
 * меняется мгновенно (`ec.setMultiPv` → React state → инпут показывает
 * новое значение), engine же получает только финальное значение когда
 * пользователь перестал кликать. Без debounce быстрые клики `+`/`+`/`+`
 * рождали 3 последовательных `stop` → `setoption` → `go` в bridge с
 * пересечением фаз, что приводило к зависанию engine.
 */
const ENGINE_OPTION_DEBOUNCE_MS = 250;

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
  /** KS-3067: 0..1, прогресс загрузки wasm. Только для wasm-источника. */
  loadProgress: number;
  /** KS-3067: причина error-состояния. Только для wasm. Для external — null. */
  errorReason: EngineErrorReason;
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

  // KS-3112: debounce параметров engine. UI-state продолжает идти
  // напрямую через `multiPv`/`depth` от useEngineConfig (optimistic UI —
  // инпут показывает новое значение сразу). В engine же передаём
  // debounced-версию: при быстром стуке `+`/`+`/`+` запросов в bridge
  // улетит только один — с финальным значением. До этого исправления
  // каждый клик запускал `stop`+`setoption`+`go` и bridge получал
  // setoption в неконсистентной фазе (engine ещё не дослал bestmove
  // от предыдущего stop), что приводило к зависанию.
  const debouncedMultiPv = useDebouncedValue(multiPv, ENGINE_OPTION_DEBOUNCE_MS);
  const debouncedDepth = useDebouncedValue(depth, ENGINE_OPTION_DEBOUNCE_MS);

  const wasm = useStockfish({
    depth: debouncedDepth,
    multiPv: debouncedMultiPv,
  });

  const external = useExternalEngine({
    config: source === 'external' ? externalConfig : null,
    depth: debouncedDepth,
    multiPv: debouncedMultiPv,
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
        loadProgress: 1,
        errorReason: null,
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
      loadProgress: wasm.loadProgress,
      errorReason: wasm.errorReason,
    };
  }, [source, wasm, external, externalConfig]);
}
