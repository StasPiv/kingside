import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { AnalysisSidebar } from './AnalysisSidebar';
import type { AnalysisSidebarProps } from './AnalysisSidebar';

/**
 * KS-2866 (ADR-060 §10.1 FR3): smoke-тесты извлечённого AnalysisSidebar.
 *
 * Компонент presentational c множеством props (на FR4 большая часть
 * переедет в AnalysisContext). Здесь проверяем ключевые ветки рендера:
 * gameInfo desktop-wrapper, bridge promo, panel-collapse, engine-lines,
 * mobile-tabs, дисабл движка при touch+fail.
 */

function makeEc(): AnalysisSidebarProps['ec'] {
  return {
    engineSource: 'wasm',
    setEngineSource: vi.fn(),
    externalConfig: null,
    setExternalConfig: vi.fn(),
    savedConfigs: [],
    showEngineSettings: false,
    setShowEngineSettings: vi.fn(),
    extUrlInput: '',
    setExtUrlInput: vi.fn(),
    extKeyInput: '',
    setExtKeyInput: vi.fn(),
    extNameInput: '',
    setExtNameInput: vi.fn(),
    uciThreads: '1',
    setUciThreads: vi.fn(),
    uciHash: '128',
    setUciHash: vi.fn(),
    multiPv: 3,
    setMultiPv: vi.fn(),
    showEngineModal: false,
    setShowEngineModal: vi.fn(),
    handleConnectExternal: vi.fn(),
    handleDeleteConfig: vi.fn(),
    handleSelectSavedConfig: vi.fn(),
    handleSwitchToWasm: vi.fn(),
  } as unknown as AnalysisSidebarProps['ec'];
}

function makeProps(overrides: Partial<AnalysisSidebarProps> = {}): AnalysisSidebarProps {
  return {
    gameInfo: undefined,
    activeSource: 'wasm',
    bridgePromoDismissed: true, // hide by default
    onDismissBridgePromo: vi.fn(),
    engineName: 'Stockfish',
    engineStatusSuffix: '',
    engineErrorMessage: null,
    sfState: 'ready',
    analysisEnabled: false,
    wasmSupported: true,
    isTouchDevice: false,
    engineFailed: false,
    onToggleAnalysis: vi.fn(),
    ec: makeEc(),
    panelStates: { gameInfo: true, engine: true, moves: true, ai: true },
    onTogglePanel: vi.fn(),
    displayedLines: [],
    evalIsBlackTurn: false,
    currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    treeOpeningName: null,
    onTreeMove: vi.fn(),
    onTreeHover: vi.fn(),
    history: [],
    currentGlobalIndex: -1,
    onMoveClick: vi.fn(),
    onPromoteVariation: vi.fn(),
    onDeleteVariation: vi.fn(),
    onTruncateRemaining: vi.fn(),
    onSetNag: vi.fn(),
    onSetComment: vi.fn(),
    onSetVariationColor: vi.fn(),
    mobileTab: 'moves',
    onMobileTabChange: vi.fn(),
    // KS-3597 (ADR-099 F2): дефолтные значения для новых required props.
    // Maia в idle (никакого UI-эффекта в существующих smoke), sortMode
    // stockfish, supportsSearchmoves=true (типичный wasm-кейс).
    maia: {
      elo: 1500,
      setElo: vi.fn(),
      status: 'idle' as const,
      error: null,
      retry: vi.fn(),
      getProbability: () => undefined,
      policyByMove: {},
    },
    sortMode: 'stockfish' as const,
    onSortModeChange: vi.fn(),
    engineSupportsSearchmoves: true,
    maiaTopMoves: [],
    ...overrides,
  };
}

describe('<AnalysisSidebar> (KS-2866)', () => {
  it('рендерит контейнер analysis-sidebar', () => {
    renderWithProviders(<AnalysisSidebar {...makeProps()} />);
    expect(screen.getByTestId('analysis-sidebar')).toBeInTheDocument();
  });

  it('GameMetaBar desktop-wrapper показывается когда gameInfo задан', () => {
    renderWithProviders(
      <AnalysisSidebar
        {...makeProps({
          gameInfo: {
            white: { username: 'Alice', rating: 1500 },
            black: { username: 'Bob', rating: 1400 },
          },
        })}
      />,
    );
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
  });

  it('bridge-promo отсутствует если dismissed=true', () => {
    renderWithProviders(<AnalysisSidebar {...makeProps()} />);
    expect(document.querySelector('.bridge-promo')).toBeNull();
  });

  it('bridge-promo показывается при wasm + не-dismissed', () => {
    const onDismiss = vi.fn();
    renderWithProviders(
      <AnalysisSidebar
        {...makeProps({
          bridgePromoDismissed: false,
          onDismissBridgePromo: onDismiss,
        })}
      />,
    );
    const promo = document.querySelector('.bridge-promo');
    expect(promo).not.toBeNull();
    const dismissBtn = promo!.querySelector(
      '.bridge-promo__dismiss',
    ) as HTMLButtonElement | null;
    fireEvent.click(dismissBtn!);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('engine-toggle вызывает onToggleAnalysis', () => {
    const onToggle = vi.fn();
    renderWithProviders(
      <AnalysisSidebar {...makeProps({ onToggleAnalysis: onToggle })} />,
    );
    // testid stockfish-toggle — desktop вариант
    fireEvent.click(screen.getAllByTestId('stockfish-toggle')[0]);
    expect(onToggle).toHaveBeenCalled();
  });

  it('engine-toggle скрыт при touch+failed', () => {
    renderWithProviders(
      <AnalysisSidebar
        {...makeProps({ isTouchDevice: true, engineFailed: true })}
      />,
    );
    expect(screen.queryAllByTestId('stockfish-toggle').length).toBe(0);
  });

  it('engine-panel collapsed скрывает stockfish-lines в desktop-секции', () => {
    renderWithProviders(
      <AnalysisSidebar
        {...makeProps({
          panelStates: { gameInfo: true, engine: false, moves: true, ai: true },
          analysisEnabled: true,
          displayedLines: [
            {
              multipv: 1,
              depth: 18,
              score: { type: 'cp', value: 30 },
              pv: ['e2e4'],
            } as never,
          ],
        })}
      />,
    );
    // В desktop engine-panel при collapsed=false body не отрисуется,
    // поэтому stockfish-line будет ТОЛЬКО в mobile-секции.
    const desktopLines = document.querySelectorAll(
      '.analysis-desktop-only .stockfish-line',
    );
    expect(desktopLines.length).toBe(0);
    const allLines = document.querySelectorAll('.stockfish-line');
    expect(allLines.length).toBeGreaterThan(0); // mobile есть всегда
  });

  it('клик по mobile-tab вызывает onMobileTabChange', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisSidebar {...makeProps({ onMobileTabChange: onChange })} />,
    );
    const tabs = document.querySelectorAll('.analysis-mobile-tab');
    // KS-3687: добавлена 4-я вкладка «AI».
    expect(tabs.length).toBe(4);
    fireEvent.click(tabs[1]); // Engine
    expect(onChange).toHaveBeenCalledWith('engine');
    fireEvent.click(tabs[3]); // AI
    expect(onChange).toHaveBeenCalledWith('ai');
  });

  it('KS-3687: при aiPositionComment рендерится отдельный desktop-блок AI и mobile-секция', () => {
    // Минимальный контроллер для AiPositionCommentPanel.
    const aiCtl = {
      state: { kind: 'idle' as const },
      request: vi.fn(),
      regenerate: vi.fn(),
      softCounter: { used: 0, limit: 20, windowMin: 20 },
      overlay: null,
      overlayHidden: false,
      toggleOverlay: vi.fn(),
    };
    renderWithProviders(
      <AnalysisSidebar
        {...makeProps({
          aiPositionComment: aiCtl,
          mobileTab: 'ai',
        })}
      />,
    );
    // Desktop: отдельная collapsible-панель с заголовком «AI».
    const aiPanel = document.querySelector(
      '[data-testid="analysis-ai-panel"]',
    );
    expect(aiPanel).not.toBeNull();
    // Mobile: секция активна, внутри сам AiPositionCommentPanel.
    const mobileSection = document.querySelector(
      '.analysis-mobile-section--ai.active',
    );
    expect(mobileSection).not.toBeNull();
    expect(
      mobileSection?.querySelector('[data-testid="ai-position-comment-mobile"]'),
    ).not.toBeNull();
  });

  it('KS-3687: aiPositionComment отсутствует → AI-блок и mobile-секция не рендерятся', () => {
    renderWithProviders(
      <AnalysisSidebar {...makeProps({ mobileTab: 'ai' })} />,
    );
    expect(
      document.querySelector('[data-testid="analysis-ai-panel"]'),
    ).toBeNull();
    expect(
      document.querySelector('.analysis-mobile-section--ai'),
    ).toBeNull();
  });

  it('multiPv − / + кнопки вызывают ec.setMultiPv', () => {
    const ec = makeEc();
    renderWithProviders(<AnalysisSidebar {...makeProps({ ec })} />);
    // Берём первую десктоп-кнопку «−»
    const minusBtns = document.querySelectorAll('.engine-multipv-btn');
    expect(minusBtns.length).toBeGreaterThan(0);
    fireEvent.click(minusBtns[0]);
    expect(ec.setMultiPv).toHaveBeenCalled();
  });

  it('engine settings button (⚙) вызывает ec.setShowEngineModal(true)', () => {
    const ec = makeEc();
    renderWithProviders(<AnalysisSidebar {...makeProps({ ec })} />);
    const settingsBtn = document.querySelector(
      '.engine-settings-btn',
    ) as HTMLButtonElement | null;
    expect(settingsBtn).not.toBeNull();
    fireEvent.click(settingsBtn!);
    expect(ec.setShowEngineModal).toHaveBeenCalledWith(true);
  });

  it('заголовок engine-panel содержит engineName + statusSuffix', () => {
    renderWithProviders(
      <AnalysisSidebar
        {...makeProps({
          engineName: 'Stockfish 16',
          engineStatusSuffix: ' · Ready',
        })}
      />,
    );
    // AnalysisSidebar рендерит engineName в двух местах одновременно
    // (desktop panel-title + mobile engine-meta) — используем getAllByText.
    expect(screen.getAllByText(/Stockfish 16/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ready/).length).toBeGreaterThan(0);
  });

  it('mobile-tabs: tree-таб рендерит ArchiveTreePanel только при выборе', () => {
    renderWithProviders(
      <AnalysisSidebar {...makeProps({ mobileTab: 'moves' })} />,
    );
    expect(
      document.querySelectorAll('.analysis-mobile-section--tree').length,
    ).toBe(0);
  });
});
