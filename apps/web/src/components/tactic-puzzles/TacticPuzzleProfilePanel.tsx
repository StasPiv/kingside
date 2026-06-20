/**
 * KS-4363 / ADR-136 T11. Секция «Точность» в публичном профиле
 * пользователя (`/profile/:username`).
 *
 * Источник данных: `GET /tactic-puzzles/stats/me` (KS-4356) →
 * `TacticUserStats`. Эндпоинт публичной выдачи на чужого пользователя
 * пока нет — поэтому панель показывается только при просмотре своего
 * профиля (та же логика, что у `DrillStatsPanel`).
 *
 * Содержимое:
 *   - Текущий рейтинг + Glicko deviation.
 *   - Краткие totals: attempts, solved, % solved.
 *   - Ссылка «Подробная статистика» на `/tactic-puzzles/stats` —
 *     для своего профиля.
 *
 * Если у пользователя ноль попыток (`attempts === 0`) — рендерим
 * приглашение начать тренировку, без бессмысленных «—»-полей.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TacticUserStats } from '@kingside/shared';
import { tacticPuzzleApi } from '../../api/api-tactic-puzzle';

export function TacticPuzzleProfilePanel() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<TacticUserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    tacticPuzzleApi
      .getMyStats()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Не показываем секцию, если запрос упал — не засоряем профиль
  // плашкой ошибки. Локальный отладочный вывод в консоль для разбора.
  if (error) return null;

  return (
    <div
      className="player-profile-section tactic-puzzle-profile"
      data-testid="tactic-puzzle-profile-section"
    >
      <h2>{t('profile.tactic.title', 'Tactics')}</h2>
      {loading || !stats ? (
        <p
          className="tactic-puzzle-profile__loading"
          data-testid="tactic-puzzle-profile-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      ) : stats.totals.attempts === 0 ? (
        <div
          className="tactic-puzzle-profile__empty"
          data-testid="tactic-puzzle-profile-empty"
        >
          <p>
            {t(
              'profile.tactic.empty',
              'Solve your first puzzle to see your Tactics rating here.',
            )}
          </p>
          <Link
            to="/tactic-puzzles"
            className="tactic-puzzle-profile__cta"
            data-testid="tactic-puzzle-profile-start"
          >
            {t('tacticPuzzle.start', 'Start training')} →
          </Link>
        </div>
      ) : (
        <div
          className="tactic-puzzle-profile__grid"
          data-testid="tactic-puzzle-profile-grid"
        >
          <div className="player-profile-rating-card tactic-puzzle-profile__rating-card">
            <div className="player-profile-rating-label">
              {t('profile.tactic.rating', 'Rating')}
            </div>
            <div className="player-profile-rating-value">
              {stats.rating.value}
            </div>
            <div className="tactic-puzzle-profile__rating-sub">
              ±{stats.rating.deviation}
            </div>
          </div>
          <div className="player-profile-rating-card">
            <div className="player-profile-rating-label">
              {t('profile.tactic.attempts', 'Attempts')}
            </div>
            <div className="player-profile-rating-value">
              {stats.totals.attempts}
            </div>
          </div>
          <div className="player-profile-rating-card">
            <div className="player-profile-rating-label">
              {t('profile.tactic.solved', 'Solved')}
            </div>
            <div className="player-profile-rating-value">
              {stats.totals.solved}
            </div>
          </div>
          <div className="player-profile-rating-card">
            <div className="player-profile-rating-label">
              {t('profile.tactic.solvedPercent', '% solved')}
            </div>
            <div className="player-profile-rating-value">
              {stats.totals.solvedPercent}%
            </div>
          </div>
        </div>
      )}
      <div
        className="tactic-puzzle-profile__footer"
        data-testid="tactic-puzzle-profile-footer"
      >
        <Link
          to="/tactic-puzzles/stats"
          className="tactic-puzzle-profile__link"
          data-testid="tactic-puzzle-profile-stats-link"
        >
          {t('profile.tactic.fullStats', 'Detailed stats')} →
        </Link>
      </div>
    </div>
  );
}
