import { useCallback, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useShareSprintResult } from '../hooks/useShareSprintResult';

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
  /**
   * KS-2251: дополнительный контекст для share-картинки (длительность
   * sprint'а и набор drill'ов). Прокидывается из PlayPage через
   * navigate state. Опционален — если хост не передал, share-кнопка
   * подставляет дефолты ("3 min" / "Mixed").
   */
  durationLabel?: string;
  setLabel?: string;
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

  // KS-2251: share-логика. Hook вычисляется ДО early-return missing/loaded,
  // потому что React требует стабильного порядка hooks между рендерами.
  const { status: shareStatus, share } = useShareSprintResult();
  const shareDurationLabel = state.durationLabel ?? '3 min';
  const shareSetLabel = state.setLabel ?? t('drills.sprint.leaderboard.set.mixed', 'Mixed');
  const shareAccuracyPct = useMemo(() => {
    const v = state.final?.accuracy ?? 0;
    return Math.round(Math.max(0, Math.min(1, v)) * 100);
  }, [state.final?.accuracy]);

  const handleShare = useCallback(() => {
    if (!state.final) return;
    void share({
      data: {
        score: state.final.score,
        accuracy: state.final.accuracy,
        durationLabel: shareDurationLabel,
        setLabel: shareSetLabel,
      },
      texts: {
        title: t('drills.sprint.share.shareTitle', 'My Kingside drill sprint result'),
        text: t('drills.sprint.share.shareText', {
          score: state.final.score,
          accuracy: shareAccuracyPct,
          durationLabel: shareDurationLabel,
          defaultValue:
            'I solved {{score}} drills with {{accuracy}}% accuracy in {{durationLabel}}.',
        }),
        fileName: t(
          'drills.sprint.share.fileName',
          'kingside-sprint-result.png',
        ),
      },
    });
  }, [state.final, shareDurationLabel, shareSetLabel, shareAccuracyPct, share, t]);

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
        {/* KS-2251: Share-кнопка. Status data-attr — для тестов/UI-фидбека. */}
        <button
          type="button"
          className="drill-sprint-results__share"
          data-testid="drill-sprint-results-share"
          data-share-status={shareStatus}
          disabled={shareStatus === 'preparing'}
          onClick={handleShare}
        >
          {shareStatus === 'preparing'
            ? t('drills.sprint.share.downloading', 'Preparing image…')
            : shareStatus === 'shared'
            ? t('drills.sprint.share.shared', 'Shared!')
            : shareStatus === 'copied'
            ? t('drills.sprint.share.copied', 'Link copied')
            : shareStatus === 'failed'
            ? t('drills.sprint.share.failed', 'Could not share.')
            : t('drills.sprint.share.button', 'Share')}
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
