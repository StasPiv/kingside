import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

type PuzzleStats = {
  rating: number;
  ratingDev?: number;
  solveRate: number;
  avgTimeMs: number;
  currentStreak: number;
  bestStreak?: number;
  todaySolved: number;
  todayAttempted: number;
  totalSolved?: number;
  totalAttempted?: number;
};

type RatingPoint = {
  date: string;
  rating: number;
  attempts?: number;
  solved?: number;
};

type ThemeStat = {
  theme: string;
  attempted: number;
  solved: number;
  rate: number;
};

type Attempt = {
  id: string;
  puzzleId: string;
  solved: boolean;
  timeMs: number;
  ratingBefore: number;
  ratingAfter: number;
  createdAt: string;
};

const PAGE_SIZE = 20;

export function PuzzleStatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [ratingHistory, setRatingHistory] = useState<RatingPoint[]>([]);
  const [themes, setThemes] = useState<ThemeStat[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [allAttempts, setAllAttempts] = useState<Attempt[]>([]);
  const [attemptsPage, setAttemptsPage] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([
      api.get<PuzzleStats>('/api/puzzles/stats/me').catch(() => null),
      api.get<RatingPoint[]>('/api/puzzles/stats/rating-history?days=30').catch(() => []),
      api.get<ThemeStat[]>('/api/puzzles/stats/themes').catch(() => []),
      api.get<Attempt[]>('/api/puzzles/attempts?take=100&skip=0').catch(() => []),
    ]).then(([s, rh, th, att]) => {
      if (s) setStats(s);
      setRatingHistory(Array.isArray(rh) ? rh : []);
      setThemes(Array.isArray(th) ? th : []);
      const attArr = Array.isArray(att) ? att : [];
      setAllAttempts(attArr);
      setAttempts(attArr.slice(0, PAGE_SIZE));
      setLoading(false);
    });
  }, [user]);

  const changePage = useCallback((page: number) => {
    setAttemptsPage(page);
    setAttempts(allAttempts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
  }, [allAttempts]);

  if (!user) {
    return <div className="puzzle-stats-page"><p>{t('common.loginRequired', 'Please log in')}</p></div>;
  }

  if (loading) {
    return <div className="puzzle-stats-page"><p>{t('common.loading')}</p></div>;
  }

  const totalAttemptsPages = Math.max(1, Math.ceil(allAttempts.length / PAGE_SIZE));

  // SVG rating chart
  const chartWidth = 600;
  const chartHeight = 150;
  const ratingMin = ratingHistory.length > 0 ? Math.min(...ratingHistory.map((p) => p.rating)) - 50 : 1400;
  const ratingMax = ratingHistory.length > 0 ? Math.max(...ratingHistory.map((p) => p.rating)) + 50 : 1600;
  const ratingRange = Math.max(1, ratingMax - ratingMin);
  const points = ratingHistory.map((p, i) => {
    const x = ratingHistory.length > 1 ? (i / (ratingHistory.length - 1)) * chartWidth : chartWidth / 2;
    const y = chartHeight - ((p.rating - ratingMin) / ratingRange) * chartHeight;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="puzzle-stats-page">
      <h1>{t('puzzleStats.title', 'Puzzle Statistics')}</h1>
      <Link to="/puzzles" className="back-nav-link">&larr; {t('puzzleStats.backToPuzzles', 'Back to Puzzles')}</Link>

      {/* Summary */}
      {stats && (
        <div className="puzzle-stats-summary">
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{Math.round(stats.rating)}</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.rating', 'Rating')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{Math.round(stats.solveRate)}%</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.solveRate', 'Solve Rate')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{stats.currentStreak}</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.streak', 'Streak')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{stats.avgTimeMs > 0 ? `${Math.round(stats.avgTimeMs / 1000)}s` : '—'}</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.avgTime', 'Avg Time')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{stats.todaySolved}/{stats.todayAttempted}</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.today', 'Today')}</div>
          </div>
          {stats.bestStreak != null && (
            <div className="puzzle-stats-card">
              <div className="puzzle-stats-card__value">{stats.bestStreak}</div>
              <div className="puzzle-stats-card__label">{t('puzzleStats.bestStreak', 'Best Streak')}</div>
            </div>
          )}
        </div>
      )}

      {/* Rating Graph */}
      {ratingHistory.length > 1 && (
        <div className="puzzle-stats-section">
          <h2>{t('puzzleStats.ratingGraph', 'Rating History')}</h2>
          <div className="puzzle-stats-chart">
            <svg viewBox={`-30 -10 ${chartWidth + 40} ${chartHeight + 20}`} width="100%" preserveAspectRatio="xMidYMid meet">
              <text x="-5" y="10" fontSize="10" fill="#94a3b8" textAnchor="end">{Math.round(ratingMax)}</text>
              <text x="-5" y={chartHeight} fontSize="10" fill="#94a3b8" textAnchor="end">{Math.round(ratingMin)}</text>
              <line x1="0" y1="0" x2="0" y2={chartHeight} stroke="#334155" strokeWidth="1" />
              <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} stroke="#334155" strokeWidth="1" />
              <polyline points={points} fill="none" stroke="#7c83ff" strokeWidth="2" />
              {ratingHistory.map((p, i) => {
                const x = ratingHistory.length > 1 ? (i / (ratingHistory.length - 1)) * chartWidth : chartWidth / 2;
                const y = chartHeight - ((p.rating - ratingMin) / ratingRange) * chartHeight;
                return <circle key={i} cx={x} cy={y} r="3" fill="#7c83ff" />;
              })}
            </svg>
          </div>
        </div>
      )}

      {/* Themes */}
      {themes.length > 0 && (
        <div className="puzzle-stats-section">
          <h2>{t('puzzleStats.themes', 'Themes')}</h2>
          <div className="puzzle-stats-themes">
            {themes.map((th) => (
              <div key={th.theme} className="puzzle-stats-theme">
                <div className="puzzle-stats-theme__header">
                  <span className="puzzle-stats-theme__name">{th.theme}</span>
                  <span className="puzzle-stats-theme__rate">{Math.round(th.rate)}% ({th.solved}/{th.attempted})</span>
                </div>
                <div className="puzzle-stats-theme__bar">
                  <div className="puzzle-stats-theme__fill" style={{ width: `${th.rate}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Attempts */}
      {attempts.length > 0 && (
        <div className="puzzle-stats-section">
          <h2>{t('puzzleStats.recentAttempts', 'Recent Attempts')}</h2>
          <div className="puzzle-stats-attempts">
            {attempts.map((a) => (
              <div key={a.id} className={`puzzle-stats-attempt${a.solved ? ' solved' : ' failed'}`}>
                <Link to={`/puzzle/${a.puzzleId}`} className="puzzle-stats-attempt__link">
                  #{a.puzzleId.slice(0, 6)}
                </Link>
                <span className={`puzzle-stats-attempt__result${a.solved ? ' correct' : ' wrong'}`}>
                  {a.solved ? '✓' : '✗'}
                </span>
                <span className="puzzle-stats-attempt__time">{Math.round(a.timeMs / 1000)}s</span>
                <span className="puzzle-stats-attempt__rating">
                  {Math.round(a.ratingBefore)} → {Math.round(a.ratingAfter)}
                </span>
                <span className="puzzle-stats-attempt__date">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
          {totalAttemptsPages > 1 && (
            <div className="puzzle-pagination">
              <button disabled={attemptsPage <= 0} onClick={() => changePage(attemptsPage - 1)}>
                {t('puzzleBrowser.prev', 'Prev')}
              </button>
              <span className="puzzle-pagination__info">
                {attemptsPage + 1} / {totalAttemptsPages}
              </span>
              <button disabled={attemptsPage >= totalAttemptsPages - 1} onClick={() => changePage(attemptsPage + 1)}>
                {t('puzzleBrowser.next', 'Next')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
