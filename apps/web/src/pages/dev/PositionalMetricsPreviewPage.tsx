/**
 * KS-4024 / ADR-122. Dev-only песочница для визуальной проверки
 * вкладки «Метрики» и снятия приёмочных скриншотов.
 *
 * Доступ: `/__dev/positional-metrics` (см. App.tsx).
 *
 * Загружаем фикстуру с готовой `AnalysisPositionalTraceDto` (3 ply, два id),
 * подсовываем её хуку через mock через прямое создание объекта-стейта —
 * сама `usePositionalTrace` тут не зовётся. Это чисто визуальная проба.
 */
import { useState } from 'react';
import type { AnalysisPositionalTraceDto } from '@kingside/shared';
import { PositionalMetricsPanel } from '../../components/analysis/PositionalMetricsPanel';
import type { UsePositionalTraceState } from '../../hooks/usePositionalTrace';

// 5-ply демо-трасса: материал и imbalance меняются по ходам.
const DEMO_DTO: AnalysisPositionalTraceDto = {
  analysisId: 'demo-analysis',
  sfVersion: 'sf18-trace-v2',
  durationMs: 4200,
  createdAt: '2026-06-09T10:00:00.000Z',
  updatedAt: '2026-06-09T10:00:00.000Z',
  plies: [
    {
      ply: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subterms: [
        { id: 'material', value_mg: 0, value_eg: 0 },
        { id: 'imbalance', value_mg: 0, value_eg: 0 },
        { id: 'pawn_connected', color: 'w', value_mg: 0.15, value_eg: 0.1 },
        { id: 'pawn_connected', color: 'b', value_mg: 0.15, value_eg: 0.1 },
      ] as any,
    },
    {
      ply: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subterms: [
        { id: 'material', value_mg: 0.1, value_eg: 0.05 },
        { id: 'imbalance', value_mg: 0.05, value_eg: 0 },
        { id: 'pawn_connected', color: 'w', value_mg: 0.18, value_eg: 0.12 },
        { id: 'pawn_connected', color: 'b', value_mg: 0.15, value_eg: 0.1 },
      ] as any,
    },
    {
      ply: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subterms: [
        { id: 'material', value_mg: 0.4, value_eg: 0.3 },
        { id: 'imbalance', value_mg: 0.15, value_eg: 0.1 },
        { id: 'pawn_connected', color: 'w', value_mg: 0.22, value_eg: 0.16 },
        { id: 'pawn_connected', color: 'b', value_mg: 0.12, value_eg: 0.08 },
      ] as any,
    },
    {
      ply: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subterms: [
        { id: 'material', value_mg: 0.7, value_eg: 0.6 },
        { id: 'imbalance', value_mg: 0.2, value_eg: 0.15 },
        { id: 'pawn_connected', color: 'w', value_mg: 0.25, value_eg: 0.18 },
        { id: 'pawn_connected', color: 'b', value_mg: 0.1, value_eg: 0.07 },
      ] as any,
    },
    {
      ply: 4,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subterms: [
        { id: 'material', value_mg: 1.0, value_eg: 0.85 },
        { id: 'imbalance', value_mg: 0.25, value_eg: 0.18 },
        { id: 'pawn_connected', color: 'w', value_mg: 0.3, value_eg: 0.22 },
        { id: 'pawn_connected', color: 'b', value_mg: 0.08, value_eg: 0.06 },
      ] as any,
    },
  ],
};

function makeTrace(): UsePositionalTraceState {
  return {
    status: 'synced',
    data: DEMO_DTO,
    idle: false,
    computedPlies: DEMO_DTO.plies.length,
    totalPlies: DEMO_DTO.plies.length,
    source: 'server',
    error: null,
    start: () => {},
    cancel: () => {},
    resetLocal: async () => {},
  };
}

type Scene = 'data' | 'idle' | 'no-moves';

function readSceneFromQuery(): Scene {
  if (typeof window === 'undefined') return 'data';
  const sp = new URLSearchParams(window.location.search);
  const s = sp.get('scene');
  if (s === 'idle' || s === 'no-moves' || s === 'data') return s;
  return 'data';
}

export default function PositionalMetricsPreviewPage() {
  const [currentPly, setCurrentPly] = useState(2);
  const [scene] = useState<Scene>(() => readSceneFromQuery());
  const trace =
    scene === 'idle'
      ? { ...makeTrace(), idle: true, status: 'idle' as const, data: null }
      : makeTrace();
  const uciMoves = scene === 'no-moves' ? [] : ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
  return (
    <div
      data-testid="positional-metrics-preview"
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: '0 auto',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ marginBottom: 4 }}>Positional metrics preview</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        KS-4024 · ADR-122 · песочница для приёмочных скриншотов.
      </p>
      <p style={{ fontSize: 12, color: '#555' }}>
        Текущий ply: <strong>{currentPly}</strong> (клик по точке на графике меняет).
      </p>
      <div
        style={{
          width: 720,
          maxWidth: '100%',
          border: '1px solid #ddd',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#fff',
        }}
      >
        <PositionalMetricsPanel
          trace={trace}
          uciMoves={uciMoves}
          currentPly={currentPly}
          onPlySelect={setCurrentPly}
        />
      </div>
    </div>
  );
}
