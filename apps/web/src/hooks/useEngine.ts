import { useEffect, useMemo, useRef } from 'react';
import { useStockfish } from './useStockfish';
import { useExternalEngine } from './useExternalEngine';
import { useDebouncedValue } from './useDebouncedValue';
import type { ExternalEngineConfig } from './useExternalEngine';
import type { EvalLine, EngineErrorReason } from './useStockfish';
import { track } from '../lib/events';

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
  /**
   * KS-3908 / ADR-117 C04. Когда `false` — обёртка не запускает
   * движок: `autoStart` принудительно `false`, `evaluate`/`init`/
   * `stop`/`setOption` становятся no-op, в lines возвращается
   * пустой массив. WASM-воркер не инициализируется (Stockfish 18
   * WASM весит ~6 МБ — у учеников лекции, которым `engine`
   * запрещён, это пустая трата трафика и батареи). External
   * bridge тоже не подключается (externalConfig игнорируется).
   * По умолчанию `true` — поведение совместимо со старыми
   * use-site'ами (никто из них флаг не передаёт → движок работает
   * как раньше).
   */
  enabled?: boolean;
  /**
   * KS-3404: бесконечный анализ без потолка глубины (`go infinite`) для
   * встроенного WASM-движка. Применяется только к WASM; внешний (bridge)
   * движок продолжает работать со своим `depth=99` (см. AnalysisPage —
   * external уже фактически «без потолка»). По умолчанию `false`.
   */
  infinite?: boolean;
  autoStart?: boolean;
  /**
   * KS-3596 (ADR-099 F1). UCI `searchmoves` — список ходов для
   * ограничения поиска Stockfish/external engine. Проксируется в
   * подлежащий хук. `null` / `undefined` / пустой массив → обычный
   * `go` (поведение по умолчанию для всех существующих потребителей).
   *
   * Использование в F2: AnalysisSidebar при sortMode=='maia' передаёт
   * top-N ходов от Maia (стабилизированных через useMemo), чтобы
   * Stockfish ранжировал по eval именно их. Для external bridge
   * поддержка не подтверждена R-этапом — `supportsSearchmoves: false`
   * в возврате (caller сам решает про деградацию).
   */
  searchmoves?: string[] | null;
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
  /**
   * KS-3596 (ADR-099 F1). Поддерживает ли активный источник UCI
   * `go searchmoves …`. WASM Stockfish — `true` (KS-3595 R-этап
   * подтвердил); external bridge — `false` до явной проверки (по
   * ADR-099 §7 консервативный fallback). F2 читает этот флаг чтобы
   * деградировать mode=maia для external (сортировка через Maia top-N
   * без помощи Stockfish).
   */
  supportsSearchmoves: boolean;
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
  const {
    source,
    externalConfig,
    depth = 20,
    multiPv = 3,
    infinite = false,
    autoStart = true,
    searchmoves = null,
    enabled = true,
  } = options;
  // KS-3908 / ADR-117 C04: гейт. Когда `enabled=false`, форсируем
  // autoStart=false, обнуляем external config, не пересылаем
  // searchmoves в подлежащие хуки, и в результирующем EngineResult
  // отдаём заглушки. WASM-init происходит ленивo по первому
  // `init()`/`evaluate()` — мы их превращаем в no-op, поэтому
  // воркер не появится в памяти.
  const effectiveAutoStart = enabled && autoStart;

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
  // KS-3596: тот же 250 мс debounce для searchmoves — F2 будет менять
  // массив на смену sortMode/ELO Maia, и без debounce при быстрых
  // переключениях получим серию stop+go.
  const debouncedSearchmoves = useDebouncedValue(
    searchmoves,
    ENGINE_OPTION_DEBOUNCE_MS,
  );

  const wasm = useStockfish({
    depth: debouncedDepth,
    multiPv: debouncedMultiPv,
    // KS-3404: infinite только для WASM-источника (внешний bridge — depth 99).
    infinite: source === 'wasm' && infinite && enabled,
    // KS-3596: searchmoves только для wasm — у external поддержка не
    // подтверждена R-этапом (KS-3595). External всё равно получает
    // массив (proxy через bridge), но `supportsSearchmoves: false`
    // подсказывает caller'у деградировать UX.
    // KS-3908: при `enabled=false` searchmoves не нужны (всё равно не
    // запускаем анализ).
    searchmoves:
      source === 'wasm' && enabled ? debouncedSearchmoves : null,
    autoStart: effectiveAutoStart,
  });

  const external = useExternalEngine({
    // KS-3908: при `enabled=false` external bridge тоже отключаем —
    // не открываем соединение, не отправляем go.
    config: enabled && source === 'external' ? externalConfig : null,
    depth: debouncedDepth,
    multiPv: debouncedMultiPv,
    autoStart: effectiveAutoStart && source === 'external',
    searchmoves:
      enabled && source === 'external' ? debouncedSearchmoves : null,
  });

  /**
   * KS-4727. Событие `engine_started` — один раз на сессию запуска
   * каждого источника. Используется правилом hints
   * `analysis-bridge-promo`: после 3-х запусков `source='wasm'`
   * предлагаем подключить bridge.
   *
   * Дедуп через ref: первый переход в `isReady=true` пишет событие,
   * последующие циклы isReady→false→true для того же источника
   * молчат. При смене source ref противоположного источника
   * сбрасывается — повторный запуск wasm после bridge снова даст
   * событие.
   */
  const wasmStartedRef = useRef(false);
  const externalStartedRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (source === 'wasm' && wasm.isReady && !wasmStartedRef.current) {
      wasmStartedRef.current = true;
      externalStartedRef.current = false;
      track('engine_started', { source: 'wasm' });
    } else if (
      source === 'external'
      && external.isReady
      && !externalStartedRef.current
    ) {
      externalStartedRef.current = true;
      wasmStartedRef.current = false;
      track('engine_started', { source: 'bridge' });
    }
  }, [enabled, source, wasm.isReady, external.isReady]);

  return useMemo(() => {
    // KS-3908 / ADR-117 C04. Когда движок выключен (учитель отнял
    // право «engine» у учеников), отдаём заглушку: пустые lines,
    // no-op мутаторы. UI-side эта ветка не должна рендерить
    // engine-panel (по флагу `showEnginePanel`), но если каким-то
    // упрощением вызывает `evaluate()` — никакого WASM init не
    // произойдёт.
    if (!enabled) {
      const noop = () => {};
      return {
        state: 'idle',
        lines: [],
        analysisFen: null,
        bestMove: null,
        evaluate: noop,
        stop: noop,
        setOption: noop,
        init: noop,
        cleanup: noop,
        isReady: false,
        engineName: '',
        engineSource: source,
        errorMessage: null,
        loadProgress: 0,
        errorReason: null,
        // false — caller не должен пытаться задействовать sort=maia
        // через searchmoves: они всё равно не уйдут.
        supportsSearchmoves: false,
      };
    }
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
        // KS-3596: external bridge — searchmoves поддержка не
        // подтверждена. По дефолту ADR-099 §7 — `false`.
        supportsSearchmoves: false,
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
      // KS-3596: wasm Stockfish 18 поддерживает searchmoves (R-этап
      // KS-3595 подтвердил). UI может включать sort=maia без оговорок.
      supportsSearchmoves: true,
    };
  }, [source, wasm, external, externalConfig, enabled]);
}
