import type { GameStepPayload } from '@kingside/shared';

import { GameStep } from '../components/lessons/steps/GameStep';

/**
 * KS-3186: dev-страница, повторяющая реальную цепочку контейнеров
 * LessonPage для шага «Партия». Используется Playwright'ом для
 * воспроизведения регрессии вёрстки.
 *
 * Структура совпадает с `apps/web/src/pages/LessonPage.tsx` для шага
 * `lesson-step lesson-step--game`:
 *
 *   .lesson-page
 *     .lesson-progress-sticky (моковая полоса прогресса)
 *     ol.lesson-step-list
 *       li.lesson-step.lesson-step--game
 *         header.lesson-step__header
 *           #N · ПАРТИЯ
 *         GameStep payload={...}
 */
const SAMPLE_PGN = `[Event "Tata Steel Masters 2026"]
[Site "Wijk aan Zee NED"]
[Date "2026.01.20"]
[Round "5"]
[White "Firouzja, Alireza"]
[WhiteElo "2759"]
[Black "Sindarov, Javokhir"]
[BlackElo "2776"]
[Result "1/2-1/2"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3 Bc5 5. O-O d6 6. c3 O-O 7. Re1 h6 8. Nbd2
a6 9. Bxc6 bxc6 10. d4 Re8 11. dxe5 dxe5 12. Nc4 Bb6 13. a4 a5 14. Be3 Bxe3
15. Nxe3 Qe7 16. Qc2 Be6 17. Nf5 Bxf5 18. exf5 Rad8 19. h3 c5 20. Re3 Nd5
21. Ree1 f6 22. Re3 Rd7 23. Rae1 Red8 24. R3e2 Qd6 25. Nh4 Kh7 26. Nf3 Kg8
27. Nh4 Kh7 28. Nf3 1/2-1/2`;

export function DevLessonGameStepPage() {
  const payload: GameStepPayload = {
    type: 'game',
    sourceType: 'pgn',
    pgn: SAMPLE_PGN,
  };
  return (
    // KS-3186 v3: реальная пользовательская страница урока использует
    // `<div class="user-lesson-page">` (UserLessonView), а НЕ
    // `.lesson-page` (legacy LessonPage). Поэтому фикс должен быть на
    // user-lesson-page тоже. Здесь рендерим эквивалентный wrapper.
    <div className="user-lesson-page" data-testid="dev-user-lesson-page">
      <nav className="user-lesson-page__breadcrumbs">
        <a href="#">Уроки</a>
        <span className="user-lesson-page__sep"> / </span>
        <a href="#">Все курсы</a>
      </nav>
      <header className="user-lesson-page__header">
        <h1>Новый урок</h1>
      </header>
      <div className="lesson-progress-sticky">
        <div className="user-lesson-page__progress">
          Шаг 1/2 — 2 пройдено (100%)
        </div>
      </div>
      <ol className="lesson-step-list" data-testid="lesson-step-list">
        <li
          className="lesson-step lesson-step--game"
          data-testid="lesson-step-0"
          data-step-state="in-progress"
        >
          <header className="lesson-step__header">
            <span className="lesson-step-order">#0</span>
            <span className="lesson-step-type">ПАРТИЯ</span>
          </header>
          <GameStep payload={payload} hideNext={false} />
        </li>
      </ol>
    </div>
  );
}
