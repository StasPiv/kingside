/**
 * KS-4024. Dev-only песочница для скриншотов вкладки «Метрики»
 * именно из контекста `AnalysisSidebar` (тот же компонент, что
 * AnalysisPage монтирует в правую колонку и мобильный bottom-sheet).
 *
 * Цель: показать на реальном Sidebar 5-й accordion-блок «Метрики» на
 * desktop и 5-ю мобильную вкладку — без необходимости поднимать всю
 * AnalysisPage с живым `gameId` и реальной архивной партией.
 */
import { useState } from 'react';
import type { GamePositionalTraceDto } from '@kingside/shared';
import { AnalysisSidebar } from '../analysis/AnalysisSidebar';
import type {
  AnalysisMobileTab,
  AnalysisPanelKey,
} from '../analysis/AnalysisSidebar';
import type { PanelStates } from '../analysis/accordionTogglePanel';
import { PositionalMetricsPanel } from '../../components/analysis/PositionalMetricsPanel';
import type { UsePositionalTraceState } from '../../hooks/usePositionalTrace';

const DEMO_DTO: GamePositionalTraceDto = {
  gameId: 'demo-game',
  sfVersion: 'sf18-trace-v2',
  durationMs: 4200,
  createdAt: '2026-06-09T10:00:00.000Z',
  updatedAt: '2026-06-09T10:00:00.000Z',
  plies: [0, 1, 2, 3, 4, 5].map((i) => ({
    ply: i,
    subterms: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'material', value_mg: i * 0.18, value_eg: i * 0.12 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'imbalance', value_mg: i * 0.06, value_eg: i * 0.04 } as any,
      {
        id: 'pawn_connected',
        color: 'w',
        value_mg: 0.15 + i * 0.03,
        value_eg: 0.1 + i * 0.02,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        id: 'pawn_connected',
        color: 'b',
        value_mg: 0.15 - i * 0.01,
        value_eg: 0.1 - i * 0.005,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ],
  })),
};

const NOOP = () => {};

function makeTrace(): UsePositionalTraceState {
  return {
    status: 'synced',
    data: DEMO_DTO,
    computedPlies: DEMO_DTO.plies.length,
    totalPlies: DEMO_DTO.plies.length,
    source: 'server',
    error: null,
    start: NOOP,
    cancel: NOOP,
    resetLocal: async () => {},
  };
}

export default function AnalysisMetricsTabPreviewPage() {
  const [mobileTab, setMobileTab] = useState<AnalysisMobileTab>('metrics');
  const [panelStates, setPanelStates] = useState<PanelStates>({
    gameInfo: false,
    engine: false,
    moves: false,
    ai: false,
    book: false,
    metrics: true,
  });
  const togglePanel = (key: AnalysisPanelKey) =>
    setPanelStates((p) => ({ ...p, [key]: !p[key] }));

  const metricsContent = (
    <PositionalMetricsPanel
      trace={makeTrace()}
      uciMoves={[]}
      currentPly={3}
      onPlySelect={NOOP}
    />
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const minimalEc: any = {
    engineSource: 'wasm',
    multiPv: 3,
    uciThreads: '1',
    uciHash: '128',
  };

  return (
    <div
      style={{
        padding: 16,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 720,
      }}
    >
      <h1 style={{ marginTop: 0 }}>AnalysisSidebar · вкладка «Метрики»</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        KS-4024 · ADR-122 · реальный <code>AnalysisSidebar</code> с открытым
        блоком «Метрики» и активной мобильной вкладкой.
      </p>
      <AnalysisSidebar
        activeSource="wasm"
        bridgePromoDismissed
        onDismissBridgePromo={NOOP}
        engineName="Stockfish"
        engineStatusSuffix=""
        engineErrorMessage={null}
        sfState="ready"
        analysisEnabled={false}
        wasmSupported
        isTouchDevice={false}
        engineFailed={false}
        onToggleAnalysis={NOOP}
        ec={minimalEc}
        panelStates={panelStates}
        onTogglePanel={togglePanel}
        displayedLines={[]}
        evalIsBlackTurn={false}
        currentFen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        treeOpeningName={null}
        onTreeMove={NOOP}
        onTreeHover={NOOP}
        history={[]}
        currentGlobalIndex={-1}
        onMoveClick={NOOP}
        onPromoteVariation={NOOP}
        onDeleteVariation={NOOP}
        onTruncateRemaining={NOOP}
        onSetNag={NOOP}
        onSetComment={NOOP}
        onSetVariationColor={NOOP}
        mobileTab={mobileTab}
        onMobileTabChange={setMobileTab}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        maia={{} as any}
        sortMode="stockfish"
        onSortModeChange={NOOP}
        engineSupportsSearchmoves={false}
        maiaTopMoves={[]}
        metricsContent={metricsContent}
      />
    </div>
  );
}
