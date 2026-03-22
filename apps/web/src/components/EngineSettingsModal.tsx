import { useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ExternalEngineConfig } from '../hooks/useExternalEngine';
import type { EngineSource } from '../hooks/useEngine';

type Props = {
  engineSource: EngineSource;
  multiPv: number;
  setMultiPv: (v: number) => void;
  extUrlInput: string;
  setExtUrlInput: (v: string) => void;
  extKeyInput: string;
  setExtKeyInput: (v: string) => void;
  extNameInput: string;
  setExtNameInput: (v: string) => void;
  uciThreads: string;
  setUciThreads: (v: string) => void;
  uciHash: string;
  setUciHash: (v: string) => void;
  savedConfigs: ExternalEngineConfig[];
  externalConfig: ExternalEngineConfig | null;
  setEngineOption: (name: string, value: string) => void;
  onClose: () => void;
  onSwitchToWasm: () => void;
  onSwitchToExternal: () => void;
  onConnectExternal: () => void;
  onSelectSavedConfig: (cfg: ExternalEngineConfig) => void;
  onDeleteConfig: (wsUrl: string) => void;
};

export function EngineSettingsModal({
  engineSource,
  multiPv,
  setMultiPv,
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
  savedConfigs,
  externalConfig,
  setEngineOption,
  onClose,
  onSwitchToWasm,
  onSwitchToExternal,
  onConnectExternal,
  onSelectSavedConfig,
  onDeleteConfig,
}: Props) {
  const { t } = useTranslation();
  const configFileRef = useRef<HTMLInputElement>(null);

  const handleLoadConfigFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (!text) return;
      const lines = text.split('\n');
      let port = '9090';
      let secret = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes(':')) continue;
        const colonIdx = trimmed.indexOf(':');
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key === 'port') port = val;
        if (key === 'secret' || key === 'secret_key') secret = val;
      }
      setExtUrlInput(`ws://localhost:${port}`);
      setExtKeyInput(secret);
      if (!extNameInput) setExtNameInput('Local Engine');
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [extNameInput, setExtUrlInput, setExtKeyInput, setExtNameInput]);

  return (
    <div className="engine-modal-overlay" onClick={onClose}>
      <div className="engine-modal" onClick={(e) => e.stopPropagation()}>
        <div className="engine-modal-header">
          <h3>Engine Settings</h3>
          <button className="engine-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="engine-settings-sources">
          <button
            className={`engine-source-btn${engineSource === 'wasm' ? ' active' : ''}`}
            onClick={onSwitchToWasm}
          >
            Browser Stockfish
          </button>
          <button
            className={`engine-source-btn${engineSource === 'external' ? ' active' : ''}`}
            onClick={onSwitchToExternal}
          >
            External Engine
          </button>
        </div>

        <div className="engine-uci-options">
          <div className="engine-uci-row">
            <label>MultiPV (lines)</label>
            <input
              type="number"
              min={1}
              max={10}
              value={multiPv}
              onChange={(e) => setMultiPv(Math.max(1, Math.min(10, Number(e.target.value))))}
              className="engine-uci-input"
            />
          </div>
        </div>

        {engineSource === 'external' && (
          <div className="engine-settings-form">
            <input
              ref={configFileRef}
              type="file"
              accept=".yaml,.yml"
              style={{ display: 'none' }}
              onChange={handleLoadConfigFile}
            />
            <button
              className="engine-load-config-btn"
              onClick={() => configFileRef.current?.click()}
            >
              📂 {t('engineSettings.loadConfig')}
            </button>
            <input type="text" placeholder="Name" value={extNameInput} onChange={(e) => setExtNameInput(e.target.value)} className="engine-settings-input" />
            <input type="text" placeholder="ws://host:port" value={extUrlInput} onChange={(e) => setExtUrlInput(e.target.value)} className="engine-settings-input" />
            <input type="password" placeholder="Secret key" value={extKeyInput} onChange={(e) => setExtKeyInput(e.target.value)} className="engine-settings-input" />

            <div className="engine-uci-options">
              <div className="engine-uci-row">
                <label>Threads</label>
                <input type="number" min={1} max={512} value={uciThreads} onChange={(e) => { setUciThreads(e.target.value); setEngineOption('Threads', e.target.value); }} className="engine-uci-input" />
              </div>
              <div className="engine-uci-row">
                <label>Hash (MB)</label>
                <input type="number" min={1} max={65536} value={uciHash} onChange={(e) => { setUciHash(e.target.value); setEngineOption('Hash', e.target.value); }} className="engine-uci-input" />
              </div>
            </div>

            <div className="engine-settings-actions">
              <button onClick={onConnectExternal} className="engine-connect-btn">Connect</button>
            </div>

            {savedConfigs.length > 0 && (
              <div className="engine-saved-list">
                <div className="engine-saved-label">Saved:</div>
                {savedConfigs.map((cfg) => (
                  <div key={cfg.wsUrl} className="engine-saved-row">
                    <button className={`engine-saved-item${externalConfig?.wsUrl === cfg.wsUrl ? ' active' : ''}`} onClick={() => { onSelectSavedConfig(cfg); onClose(); }}>{cfg.name}</button>
                    <button className="engine-saved-delete" onClick={() => onDeleteConfig(cfg.wsUrl)} title="Delete">✕</button>
                  </div>
                ))}
              </div>
            )}

            <Link to="/help/external-engine" className="engine-help-link" target="_blank">
              {t('engineHelp.linkText')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
