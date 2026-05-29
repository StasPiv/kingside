// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';
import { EngineSettingsModal } from './EngineSettingsModal';

/**
 * KS-3404 — ползунок «Максимальная глубина анализа» и тумблер «Без
 * ограничения глубины» убраны из настроек движка (окно анализа всегда
 * идёт бесконечно). Регресс-гард: этих контролов в модалке больше нет.
 */

function baseProps(over: Record<string, unknown> = {}) {
  return {
    engineSource: 'wasm' as const,
    multiPv: 3,
    setMultiPv: vi.fn(),
    extUrlInput: '',
    setExtUrlInput: vi.fn(),
    extKeyInput: '',
    setExtKeyInput: vi.fn(),
    extNameInput: '',
    setExtNameInput: vi.fn(),
    uciThreads: '1',
    setUciThreads: vi.fn(),
    uciHash: '256',
    setUciHash: vi.fn(),
    savedConfigs: [],
    externalConfig: null,
    setEngineOption: vi.fn(),
    onClose: vi.fn(),
    onSwitchToWasm: vi.fn(),
    onSwitchToExternal: vi.fn(),
    onConnectExternal: vi.fn(),
    onSelectSavedConfig: vi.fn(),
    onDeleteConfig: vi.fn(),
    ...over,
  };
}

describe('<EngineSettingsModal> — KS-3404 depth controls removed', () => {
  it('WASM: нет ни ползунка глубины, ни тумблера «Без ограничения»', () => {
    renderWithProviders(<EngineSettingsModal {...baseProps({ engineSource: 'wasm' })} />);
    expect(screen.queryByTestId('engine-depth-slider')).toBeNull();
    expect(screen.queryByTestId('engine-unlimited-toggle')).toBeNull();
    expect(screen.queryByTestId('engine-unlimited-hint')).toBeNull();
    // MultiPV остаётся.
    expect(screen.getByText('MultiPV (lines)')).toBeTruthy();
  });

  it('external: тоже нет ползунка/тумблера', () => {
    renderWithProviders(<EngineSettingsModal {...baseProps({ engineSource: 'external' })} />);
    expect(screen.queryByTestId('engine-depth-slider')).toBeNull();
    expect(screen.queryByTestId('engine-unlimited-toggle')).toBeNull();
  });
});
