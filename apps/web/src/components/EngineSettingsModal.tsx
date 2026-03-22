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
  connectionState?: string;
  errorMessage?: string | null;
  onClose: () => void;
  onSwitchToWasm: () => void;
  onSwitchToExternal: () => void;
  onConnectExternal: () => void;
  onSelectSavedConfig: (cfg: ExternalEngineConfig) => void;
  onDeleteConfig: (wsUrl: string) => void;
};

function ConnectionStatus({ state, error }: { state?: string; error?: string | null }) {
  if (!state || state === 'idle') return null;
  const label =
    state === 'connecting' ? 'Connecting...'
    : state === 'ready' || state === 'analyzing' ? 'Connected'
    : state === 'error' ? (error || 'Connection failed')
    : state;
  const cls =
    state === 'connecting' ? 'engine-status--connecting'
    : state === 'ready' || state === 'analyzing' ? 'engine-status--connected'
    : 'engine-status--error';
  return <div className={`engine-connection-status ${cls}`}>{label}</div>;
}

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
  connectionState,
  errorMessage,
  onClose,
  onSwitchToWasm,
  onSwitchToExternal,
  onConnectExternal,
  onSelectSavedConfig,
  onDeleteConfig,
}: Props) {
  const { t } = useTranslation();
  const isConnecting = connectionState === 'connecting';
  const isLocalhost = extUrlInput.includes('localhost') || extUrlInput.includes('127.0.0.1');

  return (
    <div className="engine-modal-overlay" onClick={onClose}>
      <div className="engine-modal" onClick={(e) => e.stopPropagation()}>
        <div className="engine-modal-header">
          <h3>{t('engineSettings.title', 'Engine Settings')}</h3>
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
              type="text"
              placeholder={t('engineSettings.namePlaceholder', 'Engine name')}
              value={extNameInput}
              onChange={(e) => setExtNameInput(e.target.value)}
              className="engine-settings-input"
            />
            <input
              type="text"
              placeholder="ws://host:port"
              value={extUrlInput}
              onChange={(e) => setExtUrlInput(e.target.value)}
              className="engine-settings-input"
            />
            {!isLocalhost && (
              <input
                type="password"
                placeholder={t('engineSettings.keyPlaceholder', 'Secret key (not needed for localhost)')}
                value={extKeyInput}
                onChange={(e) => setExtKeyInput(e.target.value)}
                className="engine-settings-input"
              />
            )}

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

            <ConnectionStatus state={connectionState} error={errorMessage} />

            <div className="engine-settings-actions">
              <button onClick={onConnectExternal} className="engine-connect-btn" disabled={isConnecting || !extUrlInput.trim()}>
                {isConnecting ? t('engineSettings.connecting', 'Connecting...') : t('engineSettings.connect', 'Connect')}
              </button>
            </div>

            {savedConfigs.length > 0 && (
              <div className="engine-saved-list">
                <div className="engine-saved-label">{t('engineSettings.saved', 'Saved engines:')}</div>
                {savedConfigs.map((cfg) => (
                  <div key={cfg.wsUrl} className="engine-saved-row">
                    <button
                      className={`engine-saved-item${externalConfig?.wsUrl === cfg.wsUrl ? ' active' : ''}`}
                      onClick={() => { onSelectSavedConfig(cfg); onClose(); }}
                    >
                      {cfg.name}
                      <span className="engine-saved-url">{cfg.wsUrl}</span>
                    </button>
                    <button className="engine-saved-delete" onClick={() => onDeleteConfig(cfg.wsUrl)} title="Delete">✕</button>
                  </div>
                ))}
                <button
                  className="engine-add-btn"
                  onClick={() => { setExtNameInput(''); setExtUrlInput(''); setExtKeyInput(''); }}
                >
                  + {t('engineSettings.addEngine', 'Add Engine')}
                </button>
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
