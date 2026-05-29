import { useState, useCallback, useEffect } from 'react';
import { loadEngineConfigs, saveEngineConfigs } from './useEngine';
import type { EngineSource } from './useEngine';
import type { ExternalEngineConfig } from './useExternalEngine';

const DEFAULT_MULTI_PV = 3;

/**
 * KS-3085. Дефолтная глубина WASM-анализа на странице `/analysis` — 18.
 * Это точка калибровки WDL (см. `engineAdapter.ts:49-51`, `puzzleGenerator.ts:140`):
 * на 18 серверный analysis даёт стабильные WDL для precision-runner.
 * Менять default нельзя — порушит синхрон оценок раннер ↔ история.
 * Пользователь может выбрать другое значение слайдером в EngineSettingsModal.
 */
const DEFAULT_ANALYSIS_DEPTH = 18;
/** KS-3085: жёсткие границы слайдера. <10 — слишком мало для разумной оценки,
 *  >30 — на сложной позиции WASM может зависать на десятки секунд. */
const MIN_ANALYSIS_DEPTH = 10;
const MAX_ANALYSIS_DEPTH = 30;

export function useEngineConfig() {
  const [savedConfigs, setSavedConfigs] = useState<ExternalEngineConfig[]>(() => loadEngineConfigs());
  const [engineSource, setEngineSourceRaw] = useState<EngineSource>(() => {
    try {
      const saved = localStorage.getItem('engineSource');
      if (saved === 'wasm' || saved === 'external') return saved;
    } catch { /* ignore */ }
    return loadEngineConfigs().length > 0 ? 'external' : 'wasm';
  });
  const setEngineSource = useCallback((source: EngineSource) => {
    setEngineSourceRaw(source);
    try { localStorage.setItem('engineSource', source); } catch { /* ignore */ }
  }, []);
  const [externalConfig, setExternalConfig] = useState<ExternalEngineConfig | null>(() => {
    const configs = loadEngineConfigs();
    return configs.length > 0 ? configs[0] : null;
  });
  const [showEngineSettings, setShowEngineSettings] = useState(false);
  const [extUrlInput, setExtUrlInput] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.wsUrl ?? '';
  });
  const [extKeyInput, setExtKeyInput] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.secretKey ?? '';
  });
  const [extNameInput, setExtNameInput] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.name ?? '';
  });
  const [uciThreads, setUciThreads] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.uciOptions?.Threads ?? '1';
  });
  const [uciHash, setUciHash] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.uciOptions?.Hash ?? '256';
  });

  const [multiPv, setMultiPvRaw] = useState(() => {
    try {
      const saved = localStorage.getItem('analysisMultiPv');
      if (saved) { const n = Number(saved); if (n >= 1 && n <= 10) return n; }
    } catch { /* ignore */ }
    return DEFAULT_MULTI_PV;
  });
  const setMultiPv = useCallback((v: number | ((prev: number) => number)) => {
    setMultiPvRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { localStorage.setItem('analysisMultiPv', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // KS-3085: максимальная глубина WASM-анализа на странице `/analysis`.
  // localStorage-ключ `analysisDepth`. При невалидном/отсутствующем
  // значении — `DEFAULT_ANALYSIS_DEPTH=18`. Чтобы default остался
  // совместим с прежним хардкодом — пользователи без сохранённого
  // значения получают то же что было до KS-3085.
  const [analysisDepth, setAnalysisDepthRaw] = useState(() => {
    try {
      const saved = localStorage.getItem('analysisDepth');
      if (saved) {
        const n = Number(saved);
        if (
          Number.isFinite(n) &&
          n >= MIN_ANALYSIS_DEPTH &&
          n <= MAX_ANALYSIS_DEPTH
        ) {
          return n;
        }
      }
    } catch { /* ignore */ }
    return DEFAULT_ANALYSIS_DEPTH;
  });
  const setAnalysisDepth = useCallback(
    (v: number | ((prev: number) => number)) => {
      setAnalysisDepthRaw((prev) => {
        const raw = typeof v === 'function' ? v(prev) : v;
        const clamped = Math.max(
          MIN_ANALYSIS_DEPTH,
          Math.min(MAX_ANALYSIS_DEPTH, Math.round(raw)),
        );
        try { localStorage.setItem('analysisDepth', String(clamped)); } catch { /* ignore */ }
        return clamped;
      });
    },
    [],
  );
  // KS-3404: бесконечный анализ WASM (`go infinite`, без потолка глубины).
  // По умолчанию ВКЛ — пользователь просил убрать предел глубины совсем.
  // Когда выкл — `analysisDepth` работает как опциональный потолок.
  // localStorage-ключ `analysisUnlimited` ('1'/'0'); отсутствие → true.
  const [analysisUnlimited, setAnalysisUnlimitedRaw] = useState(() => {
    try {
      const saved = localStorage.getItem('analysisUnlimited');
      if (saved === '0') return false;
      if (saved === '1') return true;
    } catch { /* ignore */ }
    return true;
  });
  const setAnalysisUnlimited = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setAnalysisUnlimitedRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { localStorage.setItem('analysisUnlimited', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const [showEngineModal, setShowEngineModal] = useState(false);

  // Auto-discover localhost bridge on common port
  useEffect(() => {
    // Only probe if no saved configs and no explicit user choice
    if (savedConfigs.length > 0) return;
    try {
      if (localStorage.getItem('engineSource') === 'wasm') return;
    } catch { /* ignore */ }

    const probeUrl = 'ws://localhost:9090/ws';
    let ws: WebSocket;
    try { ws = new WebSocket(probeUrl); } catch { return; }
    const timer = setTimeout(() => { ws.close(); }, 2000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      const cfg: ExternalEngineConfig = { name: 'Local Engine', wsUrl: 'ws://localhost:9090', secretKey: '' };
      setSavedConfigs([cfg]);
      saveEngineConfigs([cfg]);
      setExternalConfig(cfg);
      setEngineSource('external');
      setExtUrlInput(cfg.wsUrl);
      setExtNameInput(cfg.name);
    };
    ws.onerror = () => { clearTimeout(timer); };
    ws.onclose = () => {};
    return () => { clearTimeout(timer); ws.close(); };
  }, []);

  // Auto-save UCI options to localStorage when they change
  useEffect(() => {
    if (savedConfigs.length === 0 || engineSource !== 'external') return;
    const updated = savedConfigs.map((c) =>
      c.wsUrl === externalConfig?.wsUrl
        ? { ...c, uciOptions: { ...c.uciOptions, Threads: uciThreads, Hash: uciHash } }
        : c,
    );
    saveEngineConfigs(updated);
  }, [uciThreads, uciHash]);

  const buildConfig = useCallback((): ExternalEngineConfig => ({
    name: extNameInput.trim() || 'External Engine',
    wsUrl: extUrlInput.trim(),
    secretKey: extKeyInput.trim(),
    uciOptions: { Threads: uciThreads, Hash: uciHash },
  }), [extUrlInput, extKeyInput, extNameInput, uciThreads, uciHash]);

  const handleConnectExternal = useCallback(() => {
    if (!extUrlInput.trim()) return;
    const cfg = buildConfig();
    setExternalConfig(cfg);
    setEngineSource('external');
    setShowEngineSettings(false);
    const updated = [...savedConfigs.filter((c) => c.wsUrl !== cfg.wsUrl), cfg];
    setSavedConfigs(updated);
    saveEngineConfigs(updated);
  }, [extUrlInput, buildConfig, savedConfigs]);

  const handleDeleteConfig = useCallback((wsUrl: string) => {
    const updated = savedConfigs.filter((c) => c.wsUrl !== wsUrl);
    setSavedConfigs(updated);
    saveEngineConfigs(updated);
    if (externalConfig?.wsUrl === wsUrl) {
      if (updated.length > 0) {
        setExternalConfig(updated[0]);
      } else {
        setExternalConfig(null);
        setEngineSource('wasm');
      }
    }
  }, [savedConfigs, externalConfig]);

  const handleSelectSavedConfig = useCallback((cfg: ExternalEngineConfig) => {
    setExternalConfig(cfg);
    setEngineSource('external');
    setExtUrlInput(cfg.wsUrl);
    setExtKeyInput(cfg.secretKey);
    setExtNameInput(cfg.name);
    setUciThreads(cfg.uciOptions?.Threads ?? '1');
    setUciHash(cfg.uciOptions?.Hash ?? '256');
    setShowEngineSettings(false);
  }, []);

  const handleSwitchToWasm = useCallback(() => {
    setEngineSource('wasm');
    setExternalConfig(null);
    setShowEngineSettings(false);
  }, []);

  return {
    engineSource,
    setEngineSource,
    externalConfig,
    setExternalConfig,
    savedConfigs,
    showEngineSettings,
    setShowEngineSettings,
    extUrlInput,
    setExtUrlInput,
    extKeyInput,
    setExtKeyInput,
    extNameInput,
    setExtNameInput,
    uciThreads,
    setUciThreads,
    uciHash,
    setUciHash,
    multiPv,
    setMultiPv,
    // KS-3085: настраиваемая глубина WASM-анализа (10..30).
    analysisDepth,
    setAnalysisDepth,
    minAnalysisDepth: MIN_ANALYSIS_DEPTH,
    maxAnalysisDepth: MAX_ANALYSIS_DEPTH,
    defaultAnalysisDepth: DEFAULT_ANALYSIS_DEPTH,
    // KS-3404: бесконечный анализ (без потолка глубины). Default true.
    analysisUnlimited,
    setAnalysisUnlimited,
    showEngineModal,
    setShowEngineModal,
    handleConnectExternal,
    handleDeleteConfig,
    handleSelectSavedConfig,
    handleSwitchToWasm,
  };
}
