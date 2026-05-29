import { EngineSettingsModal } from '../components/EngineSettingsModal';

/**
 * KS-3404 — dev-демо настроек движка ПОСЛЕ удаления ползунка глубины и
 * тумблера «Без ограничения». Окно анализа всегда бесконечное (go infinite),
 * UI-опции потолка нет. `/dev/engine-unlimited?dev_bypass=secret`.
 */
const noop = () => {};

export function DevEngineUnlimitedPage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <EngineSettingsModal
        engineSource="wasm"
        multiPv={3}
        setMultiPv={noop}
        extUrlInput=""
        setExtUrlInput={noop}
        extKeyInput=""
        setExtKeyInput={noop}
        extNameInput=""
        setExtNameInput={noop}
        uciThreads="1"
        setUciThreads={noop}
        uciHash="256"
        setUciHash={noop}
        savedConfigs={[]}
        externalConfig={null}
        setEngineOption={noop}
        onClose={noop}
        onSwitchToWasm={noop}
        onSwitchToExternal={noop}
        onConnectExternal={noop}
        onSelectSavedConfig={noop}
        onDeleteConfig={noop}
      />
    </div>
  );
}
