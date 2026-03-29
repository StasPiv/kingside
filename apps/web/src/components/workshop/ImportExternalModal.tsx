import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';

interface ImportExternalModalProps {
  source: 'chesscom' | 'lichess';
  onClose: () => void;
  onImported: () => void;
}

export function ImportExternalModal({ source, onClose, onImported }: ImportExternalModalProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<'month' | 'year' | 'all'>('month');
  const [gameType, setGameType] = useState<'all' | 'bullet' | 'blitz' | 'rapid'>('all');
  const [limit, setLimit] = useState(50);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number } | null>(null);

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const data = await api.post<{ imported: number; fileId: string }>('/api/workshop/import-external', {
        source,
        period,
        gameType: gameType === 'all' ? undefined : gameType,
        limit,
      });
      setResult({ imported: data.imported });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const sourceName = source === 'chesscom' ? 'chess.com' : 'lichess.org';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <h2>{t('workshop.import.title', 'Import from {{source}}', { source: sourceName })}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {result ? (
          <div className="import-result">
            <p>{t('workshop.import.success', '{{count}} games imported', { count: result.imported })}</p>
            <button onClick={onClose}>{t('common.close', 'Close')}</button>
          </div>
        ) : (
          <div className="import-form">
            <div className="import-field">
              <label>{t('workshop.import.period', 'Period')}</label>
              <select value={period} onChange={(e) => setPeriod(e.target.value as 'month' | 'year' | 'all')}>
                <option value="month">{t('workshop.import.lastMonth', 'Last month')}</option>
                <option value="year">{t('workshop.import.lastYear', 'Last year')}</option>
                <option value="all">{t('workshop.import.allTime', 'All time')}</option>
              </select>
            </div>

            <div className="import-field">
              <label>{t('workshop.import.gameType', 'Game type')}</label>
              <select value={gameType} onChange={(e) => setGameType(e.target.value as 'all' | 'bullet' | 'blitz' | 'rapid')}>
                <option value="all">{t('workshop.import.allTypes', 'All')}</option>
                <option value="bullet">Bullet</option>
                <option value="blitz">Blitz</option>
                <option value="rapid">Rapid</option>
              </select>
            </div>

            <div className="import-field">
              <label>{t('workshop.import.limit', 'Max games')}</label>
              <input type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </div>

            {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

            <button
              className="import-btn"
              onClick={handleImport}
              disabled={importing}
              style={{ marginTop: 12 }}
            >
              {importing ? t('common.loading') : t('workshop.import.importBtn', 'Import')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
