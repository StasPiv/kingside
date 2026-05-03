import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * KS-2241 (ADR-035 §5.5, Drills E4) — итоговая страница sprint-режима.
 *
 * Получает `final` из `location.state` (отдан PlayPage). Если state
 * отсутствует (прямой URL `/drills/sprint/results` без прохождения) —
 * показываем заглушку с кнопкой «Сыграть ещё» (без редиректа: пусть
 * пользователь увидит, что пришёл сюда не по флоу).
 *
 * Поля:
 *   - `score` — количество правильно решённых задач;
 *   - `accuracy` (0..1) — score / attempted;
 *   - `avgPrecision` (0..1) — среднее IoU по shape='squares' задачам.
 *   - `scoreId` — для линка на shared результат / leaderboard (KS-2242).
 *
 * `ended`:
 *   - 'submitted' — sprint закончен последним submit'ом;
 *   - 'expired' — таймер дошёл до 0 (видно как лейбл «время вышло»).
 */

interface FinalSummary {
  scoreId: string;
  score: number;
  accuracy: number;
  avgPrecision: number;
}

interface ResultsState {
  final: FinalSummary | null;
  ended: 'submitted' | 'expired';
}

function formatPercent(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%';
  return `${Math.round(v * 100)}%`;
}

function formatIou(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  return v.toFixed(2);
}

export function DrillSprintResultsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as ResultsState | null) ?? {
    final: null,
    ended: 'submitted',
  };

  const playAgain = () => navigate('/drills/sprint', { replace: true });

  if (!state.final) {
    return (
      <div
        className="drill-sprint-results drill-sprint-results--missing"
        data-testid="drill-sprint-results"
        data-state="missing"
      >
        <h1 className="drill-sprint-results__title">
          {t('drills.sprint.results.heading', 'Sprint results')}
        </h1>
        <p className="drill-sprint-results__missing-msg">
          {t(
            'drills.sprint.results.missingResult',
            'No sprint result to show. Start a new sprint.',
          )}
        </p>
        <button
          type="button"
          className="drill-sprint-results__play-again"
          data-testid="drill-sprint-results-play-again"
          onClick={playAgain}
        >
          {t('drills.sprint.results.playAgain', 'Play again')}
        </button>
      </div>
    );
  }

  const { final, ended } = state;
  return (
    <div
      className="drill-sprint-results"
      data-testid="drill-sprint-results"
      data-state="loaded"
      data-ended={ended}
      data-score-id={final.scoreId}
    >
      <header className="drill-sprint-results__header">
        <h1 className="drill-sprint-results__title">
          {t('drills.sprint.results.heading', 'Sprint results')}
        </h1>
      </header>

      <div className="drill-sprint-results__summary">
        <div className="drill-sprint-results__card">
          <span className="drill-sprint-results__label">
            {t('drills.sprint.results.score', 'Score')}
          </span>
          <span
            className="drill-sprint-results__value drill-sprint-results__value--score"
            data-testid="drill-sprint-results-score"
          >
            {final.score}
          </span>
        </div>
        <div className="drill-sprint-results__card">
          <span className="drill-sprint-results__label">
            {t('drills.sprint.results.accuracy', 'Accuracy')}
          </span>
          <span
            className="drill-sprint-results__value drill-sprint-results__value--accuracy"
            data-testid="drill-sprint-results-accuracy"
          >
            {formatPercent(final.accuracy)}
          </span>
        </div>
        <div className="drill-sprint-results__card">
          <span className="drill-sprint-results__label">
            {t('drills.sprint.results.avgPrecision', 'Avg IoU')}
          </span>
          <span
            className="drill-sprint-results__value drill-sprint-results__value--iou"
            data-testid="drill-sprint-results-avg-precision"
          >
            {formatIou(final.avgPrecision)}
          </span>
        </div>
      </div>

      <div className="drill-sprint-results__actions">
        <button
          type="button"
          className="drill-sprint-results__play-again"
          data-testid="drill-sprint-results-play-again"
          onClick={playAgain}
        >
          {t('drills.sprint.results.playAgain', 'Play again')}
        </button>
        {/* KS-2242: leaderboard. Линк всегда ведёт на общий
            /drills/sprint/leaderboard; конкретный scoreId хранится в
            data-score-id, leaderboard может подсветить строку. */}
        <Link
          to="/drills/sprint/leaderboard"
          className="drill-sprint-results__leaderboard"
          data-testid="drill-sprint-results-leaderboard"
        >
          {t('drills.sprint.results.openLeaderboard', 'Open leaderboard')}
        </Link>
        <Link
          to="/drills"
          className="drill-sprint-results__lobby"
          data-testid="drill-sprint-results-lobby"
        >
          {t('drills.sprint.results.openLobby', 'Back to drills')}
        </Link>
      </div>
    </div>
  );
}
