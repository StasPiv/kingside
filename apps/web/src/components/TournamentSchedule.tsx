import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

type SchedulePairing = {
  whiteId: string;
  whiteUsername: string;
  blackId: string | null;
  blackUsername: string | null;
  result: string | null;
  gameId: string | null;
  board: number;
};

type ScheduleRound = {
  roundNumber: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  pairings: SchedulePairing[];
};

interface TournamentScheduleProps {
  tournamentId: string;
  userId?: string;
  refreshKey?: number;
  pointsWin?: number;
  pointsDraw?: number;
  pointsLoss?: number;
}

export function TournamentSchedule({ tournamentId, userId, refreshKey, pointsWin = 1, pointsDraw = 0.5, pointsLoss = 0 }: TournamentScheduleProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rounds, setRounds] = useState<ScheduleRound[]>([]);

  const fetchSchedule = useCallback(async () => {
    try {
      const data = await api.get<ScheduleRound[]>(`/api/arena/${tournamentId}/schedule`);
      setRounds(data);
    } catch { /* ignore */ }
  }, [tournamentId]);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule, refreshKey]);

  if (!userId || rounds.length === 0) return null;

  // Find my pairing in each round
  const mySchedule = rounds.map((round) => {
    const myPairing = round.pairings.find(
      (p) => p.whiteId === userId || p.blackId === userId,
    );
    if (!myPairing) return null;

    const isWhite = myPairing.whiteId === userId;
    const opponentName = isWhite
      ? (myPairing.blackUsername ?? t('tournaments.bye', 'BYE'))
      : myPairing.whiteUsername;
    const isBye = !myPairing.blackId;

    const fmt = (n: number) => n === 0.5 ? '½' : String(n);
    let resultText = '—';
    if (myPairing.result) {
      if (myPairing.result === 'bye') {
        resultText = fmt(pointsWin);
      } else if (myPairing.result === '1/2-1/2') {
        resultText = fmt(pointsDraw);
      } else if (myPairing.result === '1-0') {
        resultText = isWhite ? fmt(pointsWin) : fmt(pointsLoss);
      } else if (myPairing.result === '0-1') {
        resultText = isWhite ? fmt(pointsLoss) : fmt(pointsWin);
      }
    } else if (round.status === 'active' && myPairing.gameId) {
      resultText = '•';
    }

    return {
      roundNumber: round.roundNumber,
      status: round.status,
      opponentName,
      isWhite,
      isBye,
      result: myPairing.result,
      gameId: myPairing.gameId,
      resultText,
    };
  }).filter(Boolean) as Array<{
    roundNumber: number;
    status: string;
    opponentName: string;
    isWhite: boolean;
    isBye: boolean;
    result: string | null;
    gameId: string | null;
    resultText: string;
  }>;

  if (mySchedule.length === 0) return null;

  const handleRowClick = (row: typeof mySchedule[0]) => {
    if (!row.gameId) return;
    if (row.result) {
      navigate(`/game/${row.gameId}/review`);
    } else {
      navigate(`/games/${row.gameId}/watch`);
    }
  };

  const getResultClass = (row: typeof mySchedule[0]): string => {
    if (!row.result) return '';
    if (row.isBye) return 'schedule-result--win';
    const isWin = (row.result === '1-0' && row.isWhite) || (row.result === '0-1' && !row.isWhite);
    const isLoss = (row.result === '1-0' && !row.isWhite) || (row.result === '0-1' && row.isWhite);
    if (isWin) return 'schedule-result--win';
    if (isLoss) return 'schedule-result--loss';
    return 'schedule-result--draw';
  };

  return (
    <div className="tournament-schedule">
      <h2>{t('tournaments.schedule', 'My Schedule')}</h2>
      <table className="tournament-schedule-table">
        <thead>
          <tr>
            <th>{t('tournaments.roundN', 'Round {{n}}', { n: '' }).replace('{{n}}', '#').replace(' #', '')}</th>
            <th>{t('tournaments.opponent', 'Opponent')}</th>
            <th>{t('tournaments.color', 'Color')}</th>
            <th>{t('tournaments.result', 'Result')}</th>
          </tr>
        </thead>
        <tbody>
          {mySchedule.map((row) => (
            <tr
              key={row.roundNumber}
              className={`schedule-row${row.gameId ? ' schedule-row--clickable' : ''}${row.status === 'active' ? ' schedule-row--active' : ''}`}
              onClick={() => handleRowClick(row)}
            >
              <td className="schedule-round">{row.roundNumber}</td>
              <td className="schedule-opponent">{row.opponentName}</td>
              <td className="schedule-color">{row.isBye ? '—' : row.isWhite ? '○' : '●'}</td>
              <td className={`schedule-result ${getResultClass(row)}`}>{row.resultText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
