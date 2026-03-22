import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type RatingChange = {
  whiteRatingBefore: number;
  whiteRatingAfter: number;
  blackRatingBefore: number;
  blackRatingAfter: number;
};

type GameData = {
  white: { username: string };
  black: { username: string };
  result: string;
  whiteRatingBefore?: number | null;
  blackRatingBefore?: number | null;
  ratingChange?: RatingChange;
};

type Props = {
  gameData: GameData;
  resultPgn: string | undefined;
  collapsed: boolean;
  onToggle: () => void;
};

function RatingDiff({ before, after }: { before: number; after: number }) {
  const diff = after - before;
  const cls = diff > 0 ? 'positive' : diff < 0 ? 'negative' : '';
  return (
    <span className={`rating-diff ${cls}`}>
      ({diff > 0 ? '+' : ''}{diff})
    </span>
  );
}

export function GameInfoPanel({ gameData, resultPgn, collapsed, onToggle }: Props) {
  const { t } = useTranslation();

  return (
    <div className="analysis-panel">
      <div className="analysis-panel-header" onClick={onToggle}>
        <span className="analysis-panel-header-left">
          <span className="analysis-panel-icon">&#9432;</span>
          <span className="analysis-panel-title">
            {t('review.gameInfo', 'Game Information')}
          </span>
        </span>
        <span className="analysis-panel-header-right">
          <Link
            to="/profile"
            className="analysis-panel-back-link"
            onClick={(e) => e.stopPropagation()}
          >
            {t('review.backToGames')}
          </Link>
          <span className="analysis-panel-chevron">
            {collapsed ? '▸' : '▾'}
          </span>
        </span>
      </div>
      {!collapsed && (
        <div className="analysis-panel-body">
          <div className="analysis-game-players">
            <div className="analysis-game-player">
              <span className="analysis-player-dot analysis-player-dot--white" />
              <span className="analysis-game-player-name">{gameData.white.username}</span>
              {gameData.ratingChange && (
                <span className="analysis-player-rating">
                  {gameData.ratingChange.whiteRatingBefore}
                  <RatingDiff
                    before={gameData.ratingChange.whiteRatingBefore}
                    after={gameData.ratingChange.whiteRatingAfter}
                  />
                </span>
              )}
            </div>
            <span className="analysis-result-badge">{resultPgn}</span>
            <div className="analysis-game-player">
              <span className="analysis-player-dot analysis-player-dot--black" />
              <span className="analysis-game-player-name">{gameData.black.username}</span>
              {gameData.ratingChange && (
                <span className="analysis-player-rating">
                  {gameData.ratingChange.blackRatingBefore}
                  <RatingDiff
                    before={gameData.ratingChange.blackRatingBefore}
                    after={gameData.ratingChange.blackRatingAfter}
                  />
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
