import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EngineSettingsModal } from '../components/EngineSettingsModal';

/**
 * KS-3404 — dev-демо настроек движка анализа с тумблером «Без ограничения
 * глубины» (бесконечный анализ). `/dev/engine-unlimited?dev_bypass=secret`.
 * `?capped=1` — открыть в режиме «потолок» (тумблер выкл, виден ползунок).
 *
 * Для ревью решения по ползунку: по умолчанию бесконечно (тумблер ВКЛ,
 * ползунок скрыт); выкл → ползунок как опциональный потолок.
 */
const noop = () => {};

export function DevEngineUnlimitedPage() {
  const [params] = useSearchParams();
  const [unlimited, setUnlimited] = useState(params.get('capped') !== '1');
  const [depth, setDepth] = useState(18);

  return (
    <div style={{ minHeight: '100vh' }}>
      <EngineSettingsModal
        engineSource="wasm"
        multiPv={3}
        setMultiPv={noop}
        analysisDepth={depth}
        setAnalysisDepth={setDepth}
        minAnalysisDepth={10}
        maxAnalysisDepth={30}
        defaultAnalysisDepth={18}
        analysisUnlimited={unlimited}
        setAnalysisUnlimited={setUnlimited}
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
