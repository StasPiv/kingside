import { useState } from 'react';
import type { PositionStepPayload } from '@kingside/shared';

import { PositionStep } from '../components/lessons/steps/PositionStep';

/**
 * Dev-песочница для ручной проверки `PositionStep` (KS-1794).
 *
 * Маршрут не протектед — нужен для снятия скриншотов состояний через
 * Playwright и ручной проверки интерактивности. В демо-курсе (KS-1793)
 * будет настоящий шаг — эта страница остаётся как простой стенд для
 * будущих правок L-24/L-32 (итерации 2-3).
 *
 * Кнопки снизу переключают готовые сценарии: стартовая позиция с
 * ожидаемым ходом e2e4, мат в 1 (Qh5#) и ход чёрных с перевёрнутой
 * доской.
 */

type Scenario = {
  key: string;
  label: string;
  payload: PositionStepPayload;
};

const SCENARIOS: Scenario[] = [
  {
    key: 'opening-e2e4',
    label: 'Opening: e2e4',
    payload: {
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      expectedMoves: ['e2e4'],
    },
  },
  {
    key: 'mate-in-one',
    label: 'Scholar’s mate: Qh5 → Qxf7#',
    payload: {
      type: 'position',
      fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
      expectedMoves: ['h5f7'],
    },
  },
  {
    key: 'black-e7e5',
    label: 'Black to move (e7e5), flipped board',
    payload: {
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      expectedMoves: ['e7e5', 'c7c5'],
      orientation: 'black',
    },
  },
];

export function DevPositionStepPage() {
  const [current, setCurrent] = useState(SCENARIOS[0]);

  return (
    <div className="dev-position-step-page" style={{ padding: 24, maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>PositionStep — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1794 (L-23). Маршрут временный — для снятия скриншотов и ручной
        проверки. В живых уроках шаг подключается через StepRenderer.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`dev-position-scenario-${s.key}`}
            onClick={() => setCurrent(s)}
            disabled={current.key === s.key}
            style={{ padding: '6px 10px' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* key заставляет PositionStep полностью сбросить состояние при смене
          сценария — payload меняется, и внутренний useEffect на payload тоже
          сработает, но key даёт более чистый визуальный переход. */}
      <PositionStep key={current.key} payload={current.payload} hideNext />
    </div>
  );
}
