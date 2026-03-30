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

type CrossTableResultItem = {
  result: string | null;
  gameId: string | null;
  color: 'white' | 'black';
  round?: number;
};

type CrossTableData = {
  players: CrossTablePlayer[];
  results: Record<string, CrossTableResultItem[]>;
};

interface CrossTableProps {
  tournamentId: string;
  refreshKey?: number;
}

function singleDisplay(item: CrossTableResultItem): string {
  if (!item.result) return '•';
  if (item.result === '1-0') return item.color === 'white' ? '1' : '0';
  if (item.result === '0-1') return item.color === 'black' ? '1' : '0';
  if (item.result === '1/2-1/2') return '½';
  if (item.result === 'bye') return '1';
  return '';
}

function isWin(item: CrossTableResultItem): boolean {
  return (item.result === '1-0' && item.color === 'white') || (item.result === '0-1' && item.color === 'black');
}

function isLoss(item: CrossTableResultItem): boolean {
  return (item.result === '1-0' && item.color === 'black') || (item.result === '0-1' && item.color === 'white');
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

  const getCell = (rowId: string, colId: string): CrossTableResultItem[] => {
    return results[`${rowId}:${colId}`] ?? [];
  };

  const cellDisplay = (items: CrossTableResultItem[]): string => {
    if (items.length === 0) return '';
    return items.map(singleDisplay).join(' ');
  };

  const cellClass = (items: CrossTableResultItem[]): string => {
    if (items.length === 0) return '';
    const hasActive = items.some((i) => !i.result);
    if (hasActive) return 'ct-cell--active';
    const wins = items.filter(isWin).length;
    const losses = items.filter(isLoss).length;
    if (wins > losses) return 'ct-cell--win';
    if (losses > wins) return 'ct-cell--loss';
    if (wins === 0 && losses === 0) return 'ct-cell--draw';
    return 'ct-cell--draw';
  };

  const handleCellClick = (items: CrossTableResultItem[]) => {
    if (items.length === 0) return;
    // Navigate to last game with a gameId
    const last = [...items].reverse().find((i) => i.gameId);
    if (!last?.gameId) return;
    if (!last.result) navigate(`/games/${last.gameId}/watch`);
    else navigate(`/game/${last.gameId}/review`);
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
                  const items = getCell(row.userId, col.userId);
                  const hasGame = items.some((i) => i.gameId);
                  return (
                    <td
                      key={ci}
                      className={`ct-cell ${cellClass(items)}${hasGame ? ' ct-cell--clickable' : ''}`}
                      onClick={() => handleCellClick(items)}
                      title={items.length > 0 ? `${t('tournaments.vs', 'vs')} ${col.username}` : ''}
                    >
                      {cellDisplay(items)}
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
