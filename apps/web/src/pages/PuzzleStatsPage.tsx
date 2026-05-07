import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PuzzleStatsByMode } from '@kingside/shared';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { MistakesDiaryBlock } from '../components/puzzle/MistakesDiaryBlock';
import { ModesBreakdown } from '../components/puzzle/ModesBreakdown';
import { RecentAttempts, type RecentAttempt } from '../components/puzzle/RecentAttempts';

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
  /** KS-2493 (api rev:119, ADR-046 §5.3). Опционально — старый клиент без блока. */
  byMode?: PuzzleStatsByMode;
};

type RatingPoint = {
  date: string;
  rating: number;
  attempts?: number;
  solved?: number;
};

export function PuzzleStatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [ratingHistory, setRatingHistory] = useState<RatingPoint[]>([]);
  const [allAttempts, setAllAttempts] = useState<RecentAttempt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([
      api.get<PuzzleStats>('/puzzles/stats/me').catch(() => null),
      api.get<RatingPoint[]>('/puzzles/stats/rating-history?days=30').catch(() => []),
      api.get<RecentAttempt[]>('/puzzles/attempts?take=100&skip=0').catch(() => []),
    ]).then(([s, rh, att]) => {
      if (s) setStats(s);
      setRatingHistory(Array.isArray(rh) ? rh : []);
      setAllAttempts(Array.isArray(att) ? att : []);
      setLoading(false);
    });
  }, [user]);

  if (!user) {
    return <div className="puzzle-stats-page"><p>{t('common.loginRequired', 'Please log in')}</p></div>;
  }

  if (loading) {
    return <div className="puzzle-stats-page"><p>{t('common.loading')}</p></div>;
  }

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
            <div className="puzzle-stats-card__value">
              {stats.solveRate != null
                ? `${Math.round(stats.solveRate)}%`
                : stats.totalAttempted
                  ? `${Math.round(((stats.totalSolved ?? 0) / stats.totalAttempted) * 100)}%`
                  : '—'}
            </div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.solveRate', 'Solve Rate')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{stats.currentStreak ?? 0}</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.streak', 'Streak')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">{stats.avgTimeMs && stats.avgTimeMs > 0 ? `${Math.round(stats.avgTimeMs / 1000)}s` : '—'}</div>
            <div className="puzzle-stats-card__label">{t('puzzleStats.avgTime', 'Avg Time')}</div>
          </div>
          <div className="puzzle-stats-card">
            <div className="puzzle-stats-card__value">
              {stats.todaySolved != null ? `${stats.todaySolved}/${stats.todayAttempted}` : (stats.totalSolved ?? 0).toString()}
            </div>
            <div className="puzzle-stats-card__label">
              {stats.todaySolved != null ? t('puzzleStats.today', 'Today') : t('puzzleStats.solved', 'Solved')}
            </div>
          </div>
          {stats.bestStreak != null && (
            <div className="puzzle-stats-card">
              <div className="puzzle-stats-card__value">{stats.bestStreak}</div>
              <div className="puzzle-stats-card__label">{t('puzzleStats.bestStreak', 'Best Streak')}</div>
            </div>
          )}
        </div>
      )}

      {/* KS-2495 (ADR-046 §5.5): Modes breakdown — две карточки
          forced-line / play-vs-engine с метриками и ссылкой в раздел.
          Backend (rev:119, KS-2493) гарантирует обе ключа в byMode;
          если старый api или ошибка — поле отсутствует и блок не
          рендерится. */}
      {stats?.byMode && <ModesBreakdown byMode={stats.byMode} />}

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

      {/* KS-1928 / ADR-032 §3: «Слабые темы» — переехал из /lessons.
          Self-fetching блок: скрывается при пустом списке / без auth /
          ошибке API. */}
      <MistakesDiaryBlock />

      {/* KS-2498 (ADR-046 §5.8): Recent Attempts — основной клик ведёт
          на /puzzle/:id (для play-vs-engine с ?source=play-vs-engine),
          отдельная иконка «Анализ» рендерится только для forced-line.
          Источник solutionMode — KS-2494 (BE rev:120). */}
      <RecentAttempts attempts={allAttempts} />
    </div>
  );
}
