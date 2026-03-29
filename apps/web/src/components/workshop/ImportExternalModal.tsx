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
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [timeClass, setTimeClass] = useState<string>('');
  const [maxGames, setMaxGames] = useState(50);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number } | null>(null);

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const data = await api.post<{ imported: number; fileId: string }>('/api/workshop/import-external', {
        platform: source,
        year,
        month,
        ...(maxGames ? { maxGames } : {}),
        ...(timeClass ? { timeClass } : {}),
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

  const months = [
    t('workshop.import.jan', 'Jan'), t('workshop.import.feb', 'Feb'), t('workshop.import.mar', 'Mar'),
    t('workshop.import.apr', 'Apr'), t('workshop.import.may', 'May'), t('workshop.import.jun', 'Jun'),
    t('workshop.import.jul', 'Jul'), t('workshop.import.aug', 'Aug'), t('workshop.import.sep', 'Sep'),
    t('workshop.import.oct', 'Oct'), t('workshop.import.nov', 'Nov'), t('workshop.import.dec', 'Dec'),
  ];

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
              <label>{t('workshop.import.year', 'Year')}</label>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {Array.from({ length: 5 }, (_, i) => now.getFullYear() - i).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            <div className="import-field">
              <label>{t('workshop.import.month', 'Month')}</label>
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {months.map((name, i) => (
                  <option key={i + 1} value={i + 1}>{name}</option>
                ))}
              </select>
            </div>

            <div className="import-field">
              <label>{t('workshop.import.gameType', 'Game type')}</label>
              <select value={timeClass} onChange={(e) => setTimeClass(e.target.value)}>
                <option value="">{t('workshop.import.allTypes', 'All')}</option>
                <option value="bullet">Bullet</option>
                <option value="blitz">Blitz</option>
                <option value="rapid">Rapid</option>
              </select>
            </div>

            <div className="import-field">
              <label>{t('workshop.import.limit', 'Max games')}</label>
              <input type="number" min={1} max={500} value={maxGames} onChange={(e) => setMaxGames(Number(e.target.value))} />
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
