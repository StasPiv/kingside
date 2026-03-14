import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type TopGame = {
  id: string;
  whitePlayer: { id: string; username: string; rating: number };
  blackPlayer: { id: string; username: string; rating: number };
  currentFen: string;
  pgn: string | null;
};

type Tournament = {
  id: string;
  name: string;
  timeControl: string;
  activePlayers: number;
  topGames: TopGame[];
};

type Props = {
  tournament: Tournament;
};

export function WorkshopTournamentCard({ tournament }: Props) {
  const { t } = useTranslation();

  return (
    <div className="workshop-tournament-card">
      <div className="workshop-tournament-card__header">
        <h3 className="workshop-tournament-card__name">{tournament.name}</h3>
        <div className="workshop-tournament-card__meta">
          <span className="workshop-tournament-card__tc">{tournament.timeControl}</span>
          <span className="workshop-tournament-card__players">
            {t('workshop.tournaments.activePlayers', { count: tournament.activePlayers })}
          </span>
        </div>
      </div>

      {tournament.topGames.length > 0 && (
        <ul className="workshop-tournament-card__games">
          {tournament.topGames.map((game) => (
            <li key={game.id} className="workshop-tournament-card__game">
              <Link to={`/game/${game.id}/review`} className="workshop-tournament-card__game-link">
                <span className="workshop-tournament-card__player">
                  {game.whitePlayer.username}
                  <span className="workshop-tournament-card__player-rating">
                    ({game.whitePlayer.rating})
                  </span>
                </span>
                <span className="workshop-tournament-card__vs">vs</span>
                <span className="workshop-tournament-card__player">
                  {game.blackPlayer.username}
                  <span className="workshop-tournament-card__player-rating">
                    ({game.blackPlayer.rating})
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
