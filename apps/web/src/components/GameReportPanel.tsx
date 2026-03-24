import { useTranslation } from 'react-i18next';
import type { GameReport } from '../hooks/useGameReport';

interface GameReportPanelProps {
  report: GameReport | null;
  analyzing: boolean;
  error: string | null;
  onAnalyze: () => void;
  whiteName?: string;
  blackName?: string;
}

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  brilliant: { label: '!!', color: '#1baca6' },
  best: { label: 'Best', color: '#96bc4b' },
  good: { label: 'Good', color: '#7b7b7b' },
  inaccuracy: { label: '?!', color: '#f7c631' },
  mistake: { label: '?', color: '#e58f2a' },
  blunder: { label: '??', color: '#ca3431' },
  book: { label: 'Book', color: '#a88764' },
};

export function GameReportPanel({
  report,
  analyzing,
  error,
  onAnalyze,
  whiteName = 'White',
  blackName = 'Black',
}: GameReportPanelProps) {
  const { t } = useTranslation();

  if (!report && !analyzing) {
    return (
      <div className="game-report-panel">
        <button className="game-report-analyze-btn" onClick={onAnalyze} disabled={analyzing}>
          {t('gameReport.analyze', 'Analyze Game')}
        </button>
        {error && <p className="game-report-error">{error}</p>}
      </div>
    );
  }

  if (analyzing) {
    return (
      <div className="game-report-panel">
        <div className="game-report-analyzing">
          <span className="game-report-spinner" />
          {t('gameReport.analyzing', 'Analyzing...')}
        </div>
      </div>
    );
  }

  if (!report) return null;

  // Count classifications per color
  const whiteMoves = report.moves.filter((m) => m.color === 'white');
  const blackMoves = report.moves.filter((m) => m.color === 'black');

  const countByClass = (moves: typeof report.moves) => {
    const counts: Record<string, number> = {};
    for (const m of moves) {
      counts[m.classification] = (counts[m.classification] || 0) + 1;
    }
    return counts;
  };

  const whiteCounts = countByClass(whiteMoves);
  const blackCounts = countByClass(blackMoves);

  const classOrder = ['brilliant', 'best', 'good', 'inaccuracy', 'mistake', 'blunder', 'book'];

  return (
    <div className="game-report-panel">
      <div className="game-report-accuracy">
        <div className="game-report-accuracy__player">
          <span className="game-report-accuracy__name">{whiteName}</span>
          <span className="game-report-accuracy__value">{report.whiteAccuracy}%</span>
        </div>
        <div className="game-report-accuracy__player">
          <span className="game-report-accuracy__name">{blackName}</span>
          <span className="game-report-accuracy__value">{report.blackAccuracy}%</span>
        </div>
      </div>
      <div className="game-report-classifications">
        <table className="game-report-table">
          <thead>
            <tr>
              <th>{whiteName}</th>
              <th></th>
              <th>{blackName}</th>
            </tr>
          </thead>
          <tbody>
            {classOrder.map((cls) => {
              const wc = whiteCounts[cls] || 0;
              const bc = blackCounts[cls] || 0;
              if (wc === 0 && bc === 0) return null;
              const info = CLASSIFICATION_LABELS[cls];
              return (
                <tr key={cls}>
                  <td className="game-report-table__count">{wc}</td>
                  <td className="game-report-table__label">
                    <span className="game-report-class-badge" style={{ background: info.color }}>
                      {info.label}
                    </span>
                  </td>
                  <td className="game-report-table__count">{bc}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
