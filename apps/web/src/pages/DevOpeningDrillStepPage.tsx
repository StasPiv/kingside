import { useState } from 'react';
import type { OpeningDrillStepPayload } from '@kingside/shared';

import { OpeningDrillStep } from '../components/lessons/steps/OpeningDrillStep';

/**
 * Dev-песочница `OpeningDrillStep` (KS-1801 / L-32). Скриншоты и ручная
 * проверка режимов show_correction / engine_punish.
 */

type Scenario = {
  key: string;
  label: string;
  payload: OpeningDrillStepPayload;
};

const SCENARIOS: Scenario[] = [
  {
    key: 'ruy-lopez-correction',
    label: 'Ruy Lopez (show_correction)',
    payload: {
      type: 'opening_drill',
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6',
      playerSide: 'white',
      onDeviation: 'show_correction',
    },
  },
  {
    key: 'caro-kann-punish',
    label: 'Caro-Kann (engine_punish, skill 7)',
    payload: {
      type: 'opening_drill',
      pgn: '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5',
      playerSide: 'black',
      onDeviation: 'engine_punish',
      engineSkillLevel: 7,
    },
  },
  {
    key: 'italian-with-variations',
    label: 'Italian с вариантами',
    payload: {
      type: 'opening_drill',
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 (3. Bb5) Bc5 4. c3',
      playerSide: 'white',
      onDeviation: 'show_correction',
    },
  },
];

export function DevOpeningDrillStepPage() {
  const [current, setCurrent] = useState(SCENARIOS[0]);

  return (
    <div className="dev-opening-step-page" style={{ padding: 24, maxWidth: 900 }}>
      <h1 style={{ marginTop: 0 }}>OpeningDrillStep — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1801 (L-32). Дебютный тренажёр по PGN-дереву. Движок — только
        Stockfish WASM (ADR-025 §2.8).
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`dev-opening-scenario-${s.key}`}
            onClick={() => setCurrent(s)}
            disabled={current.key === s.key}
            style={{ padding: '6px 10px' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <OpeningDrillStep key={current.key} payload={current.payload} />
    </div>
  );
}
