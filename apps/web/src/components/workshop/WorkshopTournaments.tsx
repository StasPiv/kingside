import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { WorkshopTournamentCard } from './WorkshopTournamentCard';

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

export function WorkshopTournaments() {
  const { t } = useTranslation();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get<Tournament[]>('/tournaments/top-active')
      .then((data) => setTournaments(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="workshop-section-block">
      <h2 className="workshop-section-block__title">{t('workshop.tournaments.title')}</h2>

      {loading && (
        <p className="workshop-section-block__loading">{t('common.loading')}</p>
      )}

      {error && !loading && (
        <p className="workshop-section-block__error">{t('workshop.tournaments.error')}</p>
      )}

      {!loading && !error && tournaments.length === 0 && (
        <p className="workshop-section-block__empty">{t('workshop.tournaments.empty')}</p>
      )}

      {!loading && !error && tournaments.length > 0 && (
        <div className="workshop-tournaments-list">
          {tournaments.map((tournament) => (
            <WorkshopTournamentCard key={tournament.id} tournament={tournament} />
          ))}
        </div>
      )}
    </section>
  );
}
