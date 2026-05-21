import type { GameStepPayload } from '@kingside/shared';

import { GameStep } from '../components/lessons/steps/GameStep';

/**
 * KS-3183 (ADR-072 §7 L1): dev-страница для визуальной проверки layout
 * шага «Партия» в шеле урока. Рендерит `GameStep` с моковым PGN —
 * embedded AnalysisPage внутри `.lesson-game-step__viewer`. Используется
 * Playwright'ом для скриншотов light/dark × desktop/mobile.
 *
 * Не используется в продакшене (доступна только через `/dev/game-step`
 * в dev-сборке).
 */
const SAMPLE_PGN = `[Event "Demo"]
[Site "?"]
[Date "2026.05.21"]
[Round "?"]
[White "Demo White"]
[Black "Demo Black"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6
8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nbd2 Bb7 12. Bc2 Re8 13. Nf1 Bf8
14. Ng3 g6 15. Bg5 h6 16. Bd2 Bg7 17. a4 c5 18. d5 c4 19. b4 Nh7 20. Be3 1-0`;

export function DevGameStepPage() {
  const payload: GameStepPayload = {
    type: 'game',
    sourceType: 'pgn',
    pgn: SAMPLE_PGN,
  };
  return (
    <div
      style={{
        padding: 16,
        maxWidth: 1200,
        margin: '0 auto',
        // KS-3186: dev-страница живёт внутри `.app-body` flex-контейнера,
        // у flex-item-а default `min-width: min-content`, что заставляет
        // dev div растягиваться от длинных Stockfish PV-линий ниже.
        // Явный min-width: 0 + width: 100% удерживает его в ширине
        // viewport'а — в реальном LessonPage эту роль выполняет `.lesson-step`.
        minWidth: 0,
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Dev · GameStep (KS-3183)</h2>
      <GameStep payload={payload} hideNext={false} />
    </div>
  );
}
