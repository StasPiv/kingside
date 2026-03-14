import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type GameItem = {
  id: string;
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw' | null;
  opponent: { id: string; username: string; ratingBefore: number | null };
  result: string;
  timeControl: string;
  timeControlType: string | null;
  totalMoves: number;
  createdAt: string;
  ecoCode: string | null;
  openingName: string | null;
};

type Props = {
  game: GameItem;
};

const RESULT_SYMBOL: Record<string, string> = {
  win: '▲',
  loss: '▼',
  draw: '=',
};

export function WorkshopGameListItem({ game }: Props) {
  const { t } = useTranslation();

  const resultLabel =
    game.playerResult === 'win'
      ? t('profile.resultWin')
      : game.playerResult === 'loss'
      ? t('profile.resultLoss')
      : t('profile.resultDraw');

  const resultClass = game.playerResult ?? 'draw';

  return (
    <Link to={`/game/${game.id}/review`} className="workshop-game-list-item">
      <span className={`workshop-game-list-item__result workshop-game-list-item__result--${resultClass}`}>
        {RESULT_SYMBOL[game.playerResult ?? 'draw']}
      </span>
      <span className="workshop-game-list-item__opponent">
        {t('profile.vs', { opponent: game.opponent.username })}
        {game.opponent.ratingBefore != null && (
          <span className="workshop-game-list-item__rating"> ({game.opponent.ratingBefore})</span>
        )}
      </span>
      <span className="workshop-game-list-item__tc">{game.timeControl}</span>
      <span className="workshop-game-list-item__result-label">{resultLabel}</span>
      <span className="workshop-game-list-item__moves">
        {game.totalMoves} {t('profile.moves')}
      </span>
      {game.openingName && (
        <span className="workshop-game-list-item__opening" title={game.openingName}>
          {game.ecoCode && <span className="workshop-game-list-item__eco">{game.ecoCode}</span>}
          {game.openingName}
        </span>
      )}
    </Link>
  );
}
