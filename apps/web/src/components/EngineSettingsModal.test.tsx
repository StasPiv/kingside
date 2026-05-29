// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, screen } from '../test/test-utils';
import { EngineSettingsModal } from './EngineSettingsModal';

/**
 * KS-3404 — тумблер «Без ограничения глубины» (бесконечный анализ).
 * Когда ВКЛ — ползунок глубины скрыт (потолка нет); когда выкл — ползунок
 * показан как опциональный потолок. Только для WASM-источника.
 */

function baseProps(over: Record<string, unknown> = {}) {
  return {
    engineSource: 'wasm' as const,
    multiPv: 3,
    setMultiPv: vi.fn(),
    analysisDepth: 18,
    setAnalysisDepth: vi.fn(),
    minAnalysisDepth: 10,
    maxAnalysisDepth: 30,
    defaultAnalysisDepth: 18,
    analysisUnlimited: true,
    setAnalysisUnlimited: vi.fn(),
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

describe('<EngineSettingsModal> — KS-3404 unlimited depth toggle', () => {
  it('unlimited ВКЛ: тумблер checked, ползунок глубины скрыт', () => {
    renderWithProviders(<EngineSettingsModal {...baseProps({ analysisUnlimited: true })} />);
    const toggle = screen.getByTestId('engine-unlimited-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // Ползунок глубины не отрисован (потолка нет).
    expect(screen.queryByTestId('engine-depth-slider')).toBeNull();
    // Подсказка про бесконечный режим показана.
    expect(screen.getByTestId('engine-unlimited-hint')).toBeTruthy();
  });

  it('unlimited выкл: ползунок глубины показан как опциональный потолок', () => {
    renderWithProviders(<EngineSettingsModal {...baseProps({ analysisUnlimited: false })} />);
    expect(
      (screen.getByTestId('engine-unlimited-toggle') as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByTestId('engine-depth-slider')).toBeTruthy();
    expect(screen.queryByTestId('engine-unlimited-hint')).toBeNull();
  });

  it('клик по тумблеру вызывает setAnalysisUnlimited(false)', async () => {
    const setAnalysisUnlimited = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <EngineSettingsModal {...baseProps({ analysisUnlimited: true, setAnalysisUnlimited })} />,
    );
    await user.click(screen.getByTestId('engine-unlimited-toggle'));
    expect(setAnalysisUnlimited).toHaveBeenCalledWith(false);
  });

  it('external source: тумблера и ползунка нет (WASM-only)', () => {
    renderWithProviders(<EngineSettingsModal {...baseProps({ engineSource: 'external' })} />);
    expect(screen.queryByTestId('engine-unlimited-toggle')).toBeNull();
    expect(screen.queryByTestId('engine-depth-slider')).toBeNull();
  });
});
