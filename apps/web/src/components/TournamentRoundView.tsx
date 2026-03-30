import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

type Pairing = {
  id: string;
  whiteId: string;
  blackId: string | null;
  gameId: string | null;
  result: string | null;
  board: number;
};

type Round = {
  id: string;
  roundNumber: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  pairings: Pairing[];
};

interface TournamentRoundViewProps {
  round: Round;
  playerNames: Map<string, string>;
  currentUserId?: string;
  pointsWin?: number;
  pointsDraw?: number;
  pointsLoss?: number;
}

export function TournamentRoundView({ round, playerNames, currentUserId, pointsWin = 1, pointsDraw = 0.5, pointsLoss = 0 }: TournamentRoundViewProps) {
  const { t } = useTranslation();

  const getName = (id: string | null) => (id ? playerNames.get(id) ?? '?' : t('tournaments.bye', 'BYE'));

  const pw = String(pointsWin);
  const pd = String(pointsDraw);
  const pl = String(pointsLoss);

  const resultDisplay = (p: Pairing) => {
    if (!p.result) return round.status === 'active' ? '•' : '—';
    if (p.result === '1-0') return `${pw} – ${pl}`;
    if (p.result === '0-1') return `${pl} – ${pw}`;
    if (p.result === '1/2-1/2') return `${pd} – ${pd}`;
    if (p.result === 'bye') return `${pw} – ${pl}`;
    return p.result;
  };

  return (
    <div className="tournament-round-view">
      <div className="tournament-round-header">
        <h3>{t('tournaments.roundN', 'Round {{n}}', { n: round.roundNumber })}</h3>
        <span className={`tournament-round-status tournament-round-status--${round.status}`}>
          {round.status === 'active' ? t('tournaments.roundActive', 'Playing')
            : round.status === 'finished' ? t('tournaments.roundFinished', 'Finished')
            : t('tournaments.roundPending', 'Pending')}
        </span>
      </div>

      <div className="tournament-pairings">
        {[...round.pairings].sort((a, b) => {
          // Active (no result) first, then finished
          const aActive = !a.result && a.gameId ? 0 : 1;
          const bActive = !b.result && b.gameId ? 0 : 1;
          return aActive - bActive || a.board - b.board;
        }).map((p) => {
          const isMy = p.whiteId === currentUserId || p.blackId === currentUserId;
          const isActive = round.status === 'active' && p.gameId && !p.result;
          const isFinished = !!p.result && p.gameId;

          return (
            <div key={p.id} className={`tournament-pairing${isMy ? ' tournament-pairing--mine' : ''}`}>
              <span className="tournament-pairing__board">{p.board}</span>
              <span className={`tournament-pairing__player${p.result === '1-0' ? ' tournament-pairing__player--winner' : ''}`}>
                {getName(p.whiteId)}
              </span>
              <span className="tournament-pairing__result">
                {isActive && p.gameId ? (
                  <Link to={`/games/${p.gameId}/watch`} className="tournament-pairing__live">
                    {t('tournaments.live', 'LIVE')}
                  </Link>
                ) : isFinished && p.gameId ? (
                  <Link to={`/game/${p.gameId}/review`} className="tournament-pairing__review">
                    {resultDisplay(p)}
                  </Link>
                ) : (
                  resultDisplay(p)
                )}
              </span>
              <span className={`tournament-pairing__player${p.result === '0-1' ? ' tournament-pairing__player--winner' : ''}`}>
                {getName(p.blackId)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
