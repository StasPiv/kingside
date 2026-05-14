import { PrecisionScoreBlock } from '../components/precision/PrecisionScoreBlock';

/**
 * KS-3002 (ADR-065 §5.1.1, Этап 3 F1). Демо-страница `PrecisionScoreBlock`
 * для визуальной верификации (5 блоков в столбик — по одному на каждый
 * score 1..5). Используется QA/верстальщиком/Playwright-скриншотами для
 * проверки палитры §4.2 в dev-режиме.
 *
 * Маршрут: `/dev/precision-score`.
 */

const FIXTURES: Array<{ score: number | null; scorePct: number | null; label: string }> = [
  { score: 5, scorePct: 96, label: 'score=5 · scorePct=96%' },
  { score: 4, scorePct: 82, label: 'score=4 · scorePct=82%' },
  { score: 3, scorePct: 67, label: 'score=3 · scorePct=67%' },
  { score: 2, scorePct: 48, label: 'score=2 · scorePct=48%' },
  { score: 1, scorePct: 21, label: 'score=1 · scorePct=21%' },
  // KS-3003: null-state.
  { score: null, scorePct: null, label: 'score=null (legacy без WDL/cp)' },
];

export function DevPrecisionScoreBlockPage() {
  return (
    <div style={{ padding: 24, maxWidth: 640, display: 'grid', gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 18 }}>
        PrecisionScoreBlock — palette demo (ADR-065 §4.2)
      </h1>
      {FIXTURES.map((f) => (
        <div key={String(f.score)}>
          <div
            style={{
              fontSize: 12,
              opacity: 0.7,
              marginBottom: 6,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
            }}
          >
            {f.label}
          </div>
          <PrecisionScoreBlock score={f.score} scorePct={f.scorePct} />
        </div>
      ))}
    </div>
  );
}
