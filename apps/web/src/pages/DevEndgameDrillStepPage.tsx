import { useState } from 'react';
import type { EndgameDrillStepPayload } from '@kingside/shared';

import { EndgameDrillStep } from '../components/lessons/steps/EndgameDrillStep';

/**
 * Dev-песочница `EndgameDrillStep` (KS-1800 / L-24). Маршрут не
 * protected — нужен для ручной проверки UCI Skill Level и снятия
 * скриншотов против живого wasm-движка.
 */

type Scenario = {
  key: string;
  label: string;
  payload: EndgameDrillStepPayload;
};

const SCENARIOS: Scenario[] = [
  {
    key: 'promote-basic',
    label: 'Провести пешку (skill 5)',
    payload: {
      type: 'endgame_drill',
      fen: '8/3P4/8/8/4k3/8/8/3K4 w - - 0 1',
      playerSide: 'white',
      skillLevel: 5,
      winCondition: { kind: 'promote' },
      maxMoves: 8,
      hintsAllowed: true,
    },
  },
  {
    key: 'mate-qk',
    label: 'Мат ферзём и королём (skill 3)',
    payload: {
      type: 'endgame_drill',
      fen: '8/8/8/8/4k3/8/4K3/7Q w - - 0 1',
      playerSide: 'white',
      skillLevel: 3,
      winCondition: { kind: 'mate' },
      maxMoves: 15,
      hintsAllowed: true,
    },
  },
  {
    key: 'material',
    label: 'Материальный перевес +5 (skill 7)',
    payload: {
      type: 'endgame_drill',
      fen: '8/4p3/8/8/4k3/8/4K3/R7 w - - 0 1',
      playerSide: 'white',
      skillLevel: 7,
      winCondition: { kind: 'material_advantage', amount: 5 },
      maxMoves: 12,
      hintsAllowed: false,
    },
  },
];

export function DevEndgameDrillStepPage() {
  const [current, setCurrent] = useState(SCENARIOS[0]);

  return (
    <div className="dev-endgame-step-page" style={{ padding: 24, maxWidth: 900 }}>
      <h1 style={{ marginTop: 0 }}>EndgameDrillStep — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1800 (L-24). Тренажёр против Stockfish WASM с ограничением силы
        через UCI Skill Level. Серверный движок не используется (ADR-025 §2.8).
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`dev-endgame-scenario-${s.key}`}
            onClick={() => setCurrent(s)}
            disabled={current.key === s.key}
            style={{ padding: '6px 10px' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <EndgameDrillStep key={current.key} payload={current.payload} />
    </div>
  );
}
