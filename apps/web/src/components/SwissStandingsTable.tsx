import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type SwissRound = {
  round: number;
  opponentId: string | null;
  color: 'white' | 'black' | null;
  result: string | null; // 'win' | 'loss' | 'draw' | 'bye' | null
  gameId: string | null;
  points: number;
};

type SwissPlayer = {
  userId: string;
  username: string;
  score: number;
  rank: number;
  rating: number;
  buchholz: number;
  progressive: number;
  wins: number;
  draws: number;
  losses: number;
  withdrawn: boolean;
  rounds: SwissRound[];
};

interface SwissStandingsTableProps {
  standings: SwissPlayer[];
  currentUserId?: string;
  totalRounds: number;
}

function fmtPts(n: number): string {
  return n === 0.5 ? '½' : String(n);
}

export function SwissStandingsTable({ standings, currentUserId, totalRounds }: SwissStandingsTableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (standings.length === 0) {
    return <p className="tournament-tab-empty">{t('tournaments.noPlayers', 'No players yet')}</p>;
  }

  // Find rank of each player by userId for display in round cells
  const rankMap = new Map(standings.map((s) => [s.userId, s.rank]));

  const roundCols = Array.from({ length: totalRounds }, (_, i) => i + 1);

  const renderRoundCell = (player: SwissPlayer, roundNum: number) => {
    const rd = player.rounds.find((r) => r.round === roundNum);
    if (!rd) return <td key={roundNum} className="swiss-cell" />;

    if (rd.result === 'bye') {
      return (
        <td key={roundNum} className="swiss-cell swiss-cell--bye">
          {t('tournaments.bye', 'BYE')}
        </td>
      );
    }

    if (!rd.result) {
      // Active game
      const handleClick = rd.gameId ? () => navigate(`/games/${rd.gameId}/watch`) : undefined;
      return (
        <td key={roundNum} className={`swiss-cell swiss-cell--active${rd.gameId ? ' swiss-cell--clickable' : ''}`} onClick={handleClick}>
          •
        </td>
      );
    }

    const opRank = rd.opponentId ? rankMap.get(rd.opponentId) ?? '?' : '?';
    const colorIcon = rd.color === 'white' ? '○' : '●';
    const prefix = rd.result === 'win' ? '+' : rd.result === 'loss' ? '-' : '=';
    const cellClass = rd.result === 'win' ? 'swiss-cell--win' : rd.result === 'loss' ? 'swiss-cell--loss' : 'swiss-cell--draw';

    const handleClick = rd.gameId ? () => navigate(`/game/${rd.gameId}/review`) : undefined;

    return (
      <td
        key={roundNum}
        className={`swiss-cell ${cellClass}${rd.gameId ? ' swiss-cell--clickable' : ''}`}
        onClick={handleClick}
        title={`${t('tournaments.roundN', 'Round {{n}}', { n: roundNum })}: ${prefix}${opRank}${colorIcon}`}
      >
        {prefix}{opRank}{colorIcon}
      </td>
    );
  };

  return (
    <div className="swiss-standings-wrapper">
      <div className="swiss-standings-scroll">
        <table className="swiss-standings-table">
          <thead>
            <tr>
              <th className="swiss-th-rank">#</th>
              <th className="swiss-th-player">{t('tournaments.player', 'Player')}</th>
              <th className="swiss-th-num">Rtg</th>
              <th className="swiss-th-num">Pts</th>
              <th className="swiss-th-num">BH</th>
              <th className="swiss-th-num">Prg</th>
              {roundCols.map((n) => (
                <th key={n} className="swiss-th-round">{n}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.userId} className={`${s.userId === currentUserId ? 'swiss-row--self' : ''}${s.withdrawn ? ' swiss-row--withdrawn' : ''}`}>
                <td className="swiss-td-rank">{s.rank}</td>
                <td className="swiss-td-player">
                  {s.username}
                  {s.withdrawn && <span className="swiss-withdrawn-badge"> ✕</span>}
                </td>
                <td className="swiss-td-num">{s.rating}</td>
                <td className="swiss-td-num swiss-td-pts">{fmtPts(s.score)}</td>
                <td className="swiss-td-num">{s.buchholz}</td>
                <td className="swiss-td-num">{s.progressive}</td>
                {roundCols.map((n) => renderRoundCell(s, n))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
