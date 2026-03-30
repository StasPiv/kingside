import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

type CrossTablePlayer = {
  userId: string;
  username: string;
  score: number;
  rank: number;
  withdrawn: boolean;
};

type CrossTableResult = {
  result: string | null; // "1-0", "0-1", "1/2-1/2", null (not played / active)
  gameId: string | null;
  color: 'white' | 'black';
};

type CrossTableData = {
  players: CrossTablePlayer[];
  results: Record<string, CrossTableResult>;
};

interface CrossTableProps {
  tournamentId: string;
  refreshKey?: number;
}

export function CrossTable({ tournamentId, refreshKey }: CrossTableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<CrossTableData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const d = await api.get<CrossTableData>(`/api/arena/${tournamentId}/crosstable`);
      setData(d);
    } catch { /* ignore */ }
  }, [tournamentId]);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  if (!data || data.players.length === 0) return null;

  const { players, results } = data;

  const getCell = (rowId: string, colId: string): CrossTableResult | null => {
    return results[`${rowId}:${colId}`] ?? null;
  };

  const cellDisplay = (cell: CrossTableResult | null): string => {
    if (!cell) return '';
    if (!cell.result) return '•'; // active game
    if (cell.result === '1-0') return cell.color === 'white' ? '1' : '0';
    if (cell.result === '0-1') return cell.color === 'black' ? '1' : '0';
    if (cell.result === '1/2-1/2') return '½';
    if (cell.result === 'bye') return '1';
    return '';
  };

  const cellClass = (cell: CrossTableResult | null): string => {
    if (!cell) return '';
    if (!cell.result) return 'ct-cell--active';
    const won = (cell.result === '1-0' && cell.color === 'white') || (cell.result === '0-1' && cell.color === 'black');
    const lost = (cell.result === '1-0' && cell.color === 'black') || (cell.result === '0-1' && cell.color === 'white');
    if (won) return 'ct-cell--win';
    if (lost) return 'ct-cell--loss';
    return 'ct-cell--draw';
  };

  const handleCellClick = (cell: CrossTableResult | null) => {
    if (!cell?.gameId) return;
    if (!cell.result) navigate(`/games/${cell.gameId}/watch`);
    else navigate(`/game/${cell.gameId}/review`);
  };

  return (
    <div className="crosstable-wrapper">
      <h2>{t('tournaments.crosstable', 'Cross Table')}</h2>
      <div className="crosstable-scroll">
        <table className="crosstable">
          <thead>
            <tr>
              <th className="ct-rank">#</th>
              <th className="ct-name">{t('tournaments.player', 'Player')}</th>
              {players.map((_, i) => (
                <th key={i} className="ct-col-header">{i + 1}</th>
              ))}
              <th className="ct-total">{t('tournaments.score', 'Score')}</th>
            </tr>
          </thead>
          <tbody>
            {players.map((row, ri) => (
              <tr key={row.userId}>
                <td className="ct-rank">{ri + 1}</td>
                <td className="ct-name">{row.username}</td>
                {players.map((col, ci) => {
                  if (ri === ci) {
                    return <td key={ci} className="ct-cell ct-cell--diag">✕</td>;
                  }
                  const cell = getCell(row.userId, col.userId);
                  return (
                    <td
                      key={ci}
                      className={`ct-cell ${cellClass(cell)}${cell?.gameId ? ' ct-cell--clickable' : ''}`}
                      onClick={() => handleCellClick(cell)}
                      title={cell ? `${t('tournaments.vs', 'vs')} ${col.username}` : ''}
                    >
                      {cellDisplay(cell)}
                    </td>
                  );
                })}
                <td className="ct-total">{row.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
