import { Link } from 'react-router-dom';

import { ForfeitPlaceholder } from '../components/ForfeitPlaceholder';

/**
 * KS-3258 (3rd attempt): dev-страница для визуальной проверки full-page
 * forfeit-плашки из BroadcastGamePage. На dev broadcasts.kingside.site
 * блокирует localhost через CORS, поэтому прямо BroadcastGamePage с
 * реальным API локально не открыть; эта dev-страница рендерит то же
 * самое визуальное состояние с фикстурным PGN.
 *
 * Использовать через `/dev/broadcast-forfeit?dev_bypass=…`.
 */
const FIXTURE_PGN = `[Event "Super Chess Classic Romania"]
[Site "Bucharest, Romania"]
[Date "2026.05.14"]
[Round "7.5"]
[White "Firouzja, Alireza"]
[Black "Van Foreest, Jorden"]
[Result "0-1"]
[WhiteElo "2759"]
[BlackElo "2735"]
[Termination "Unplayed"]

 0-1`;

export function DevBroadcastForfeitPage() {
  return (
    <div
      className="broadcast-game-forfeit-page"
      data-testid="broadcast-game-forfeit-page"
    >
      <nav
        className="broadcast-game-forfeit-page__breadcrumbs"
        aria-label="Breadcrumbs"
      >
        <Link to="/broadcasts/x">GCT Romania 2026</Link>
        <span aria-hidden="true"> / </span>
        <Link to="/broadcasts/x/y">Round 7</Link>
      </nav>
      <h1 className="broadcast-game-forfeit-page__title">
        Firouzja, Alireza — Van Foreest, Jorden
      </h1>
      <ForfeitPlaceholder
        pgn={FIXTURE_PGN}
        testId="broadcast-game-forfeit-placeholder"
      />
    </div>
  );
}
