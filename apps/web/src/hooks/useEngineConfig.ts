import { useState, useCallback, useEffect } from 'react';
import { loadEngineConfigs, saveEngineConfigs } from './useEngine';
import type { EngineSource } from './useEngine';
import type { ExternalEngineConfig } from './useExternalEngine';

const DEFAULT_MULTI_PV = 3;

export function useEngineConfig() {
  const [savedConfigs, setSavedConfigs] = useState<ExternalEngineConfig[]>(() => loadEngineConfigs());
  const [engineSource, setEngineSource] = useState<EngineSource>(() =>
    loadEngineConfigs().length > 0 ? 'external' : 'wasm',
  );
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
  const [showEngineModal, setShowEngineModal] = useState(false);

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
    showEngineModal,
    setShowEngineModal,
    handleConnectExternal,
    handleDeleteConfig,
    handleSelectSavedConfig,
    handleSwitchToWasm,
  };
}
