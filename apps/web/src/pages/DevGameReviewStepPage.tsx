import { useState } from 'react';
import type { GameReviewStepPayload } from '@kingside/shared';

import { GameReviewStep } from '../components/lessons/steps/GameReviewStep';

/**
 * Dev-песочница для ручной проверки `GameReviewStep` (KS-1795, L-30).
 *
 * Маршрут не protected — нужен для снятия скриншотов трёх режимов
 * (gameId / pgn / empty) и ручной проверки чек-листа. В живых уроках
 * шаг подключается через StepRenderer.
 */

type Scenario = {
  key: string;
  label: string;
  payload: GameReviewStepPayload;
};

const PGN_SAMPLE = `[Event "Casual"]
[Site "Kingside"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Bxc3
9. d5 Ne5 10. bxc3 Nxc4 11. Qd4 Ncd6 12. Qxg7 Qf6 13. Qxf6 Nxf6 14. Re1+ Kd8 15. Bg5 Re8
16. Bxf6+ 1-0
`;

const SCENARIOS: Scenario[] = [
  {
    key: 'game-id',
    label: 'gameId (полный разбор через /analysis)',
    payload: { type: 'game_review', gameId: 'example-game-id' },
  },
  {
    key: 'pgn',
    label: 'pgn (встроенный PGN)',
    payload: { type: 'game_review', pgn: PGN_SAMPLE },
  },
  {
    key: 'empty',
    label: 'пустой payload (импорт)',
    payload: { type: 'game_review' },
  },
];

export function DevGameReviewStepPage() {
  const [current, setCurrent] = useState(SCENARIOS[0]);
  const [doneCount, setDoneCount] = useState(0);

  return (
    <div className="dev-game-review-step-page" style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>GameReviewStep — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1795 (L-30). Временный маршрут для скриншотов и ручной проверки
        трёх состояний шага: gameId / pgn / empty, а также чек-листа из трёх вопросов.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`dev-gr-scenario-${s.key}`}
            onClick={() => setCurrent(s)}
            disabled={current.key === s.key}
            style={{ padding: '6px 10px' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <GameReviewStep
        key={current.key}
        payload={current.payload}
        onStepDone={() => setDoneCount((n) => n + 1)}
      />

      <p
        data-testid="dev-gr-done-count"
        style={{ marginTop: 16, color: '#666', fontSize: 13 }}
      >
        onStepDone callbacks: {doneCount}
      </p>
    </div>
  );
}
