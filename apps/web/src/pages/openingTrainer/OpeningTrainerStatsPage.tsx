/**
 * KS-3283 (M2). Страница статистики прохождения репертуара.
 *
 * Маршрут: `/opening-trainer/:id/stats`.
 * Источник: `GET /opening-trainer/repertoires/:id/stats` (backend
 * a30172c / td 304).
 *
 * Что показывается:
 *   - Сводка: totalSessions, completedSessions, totalAttempts,
 *     correctAttempts, wrongAttempts, hintsUsed, accuracyPercent.
 *   - Топ-N (до 10) проблемных позиций: FEN превью (мини-доска или
 *     текст), ожидаемые ходы, самый частый wrong-move, errorRate %.
 *   - Последние сессии: score, accuracy, finishedAt (или «в процессе»
 *     если status='active' → finishedAt=null).
 *
 * Превью позиции — `MemoChessboard` (small) с FEN, без интерактивности.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
// KS-3310: используем готовый PuzzleMiniBoard из раздела задач —
// лёгкая SVG-доска с подсветкой клеток/стрелок и orientation prop.
// Раньше был свой MemoChessboard-обёртка без orientation и в стандартной
// ориентации — пользователь, тренирующий за чёрных, видел доски
// «вверх ногами».
import { PuzzleMiniBoard } from '../../components/puzzle/PuzzleMiniBoard';
import type {
  GetOpeningRepertoireResponse,
  GetOpeningRepertoireStatsResponse,
  OpeningRepertoireErrorPosition,
  TrainerColor,
} from '@kingside/shared';

function uciToSan(fen: string, uci: string | null): string {
  if (!uci || uci.length < 4) return uci ?? '—';
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return m ? m.san : uci;
  } catch {
    return uci;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFunction = any;

interface ErrorRowProps {
  row: OpeningRepertoireErrorPosition;
  /** KS-3310: ориентация доски — повторяет сторону репертуара. */
  orientation: TrainerColor;
  /**
   * KS-3310: подсветка позиции — выделяем целевую клетку (куда
   * пользователь должен был пойти) и квадрат с неправильным ходом
   * (куда пошёл вместо). Помогает зрительно понять «вот тут промах».
   */
  t: TFunction;
}

function ErrorRow({ row, orientation, t }: ErrorRowProps) {
  const expectedSan = useMemo(
    () => row.expectedMoves.map((u) => uciToSan(row.positionFen, u)).join(', '),
    [row.expectedMoves, row.positionFen],
  );
  const wrongSan = useMemo(
    () => uciToSan(row.positionFen, row.mostFrequentWrongMove),
    [row.positionFen, row.mostFrequentWrongMove],
  );
  const errorPct = Math.round(row.errorRate * 100);
  return (
    <li
      className="opening-trainer-stats__error-row"
      data-testid="opening-trainer-stats-error-row"
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        alignItems: 'center',
      }}
    >
      {/* KS-3310: PuzzleMiniBoard с orientation и подсветкой клеток —
          ожидаемый ход зелёным (куда юзер должен был пойти), фактический
          неправильный ход красной стрелкой. */}
      <div
        style={{ width: 96, height: 96, flexShrink: 0 }}
        data-testid="opening-trainer-stats-mini-board"
      >
        <PuzzleMiniBoard
          fen={row.positionFen}
          orientation={orientation}
          arrows={[
            // Ожидаемые ходы — зелёные стрелки.
            ...row.expectedMoves
              .map((u) =>
                u.length >= 4
                  ? {
                      from: u.slice(0, 2),
                      to: u.slice(2, 4),
                      color: 'green' as const,
                    }
                  : null,
              )
              .filter((a): a is NonNullable<typeof a> => a !== null),
            // Самый частый неправильный ход — красная стрелка.
            ...(row.mostFrequentWrongMove && row.mostFrequentWrongMove.length >= 4
              ? [
                  {
                    from: row.mostFrequentWrongMove.slice(0, 2),
                    to: row.mostFrequentWrongMove.slice(2, 4),
                    color: 'red' as const,
                  },
                ]
              : []),
          ]}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
        <div>
          <strong>{t('openingTrainer.stats.errorRow.expected', 'Expected')}:</strong>{' '}
          <span data-testid="opening-trainer-stats-error-expected">
            {expectedSan || '—'}
          </span>
        </div>
        <div>
          <strong>{t('openingTrainer.stats.errorRow.wrong', 'Your move')}:</strong>{' '}
          <span
            data-testid="opening-trainer-stats-error-wrong"
            style={{ color: 'var(--danger, #ef4444)' }}
          >
            {wrongSan}
          </span>
        </div>
        <div style={{ opacity: 0.75 }}>
          {t(
            'openingTrainer.stats.errorRow.counts',
            '{{wrong}} of {{total}} attempts wrong ({{pct}}%)',
            {
              wrong: row.wrongCount,
              total: row.totalCount,
              pct: errorPct,
            },
          )}
        </div>
      </div>
    </li>
  );
}

export function OpeningTrainerStatsPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [repertoire, setRepertoire] = useState<GetOpeningRepertoireResponse | null>(null);
  const [stats, setStats] = useState<GetOpeningRepertoireStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      openingTrainerApi.getRepertoire(id),
      openingTrainerApi.getRepertoireStats(id),
    ])
      .then(([rRes, sRes]) => {
        if (cancelled) return;
        if (rRes.status === 'fulfilled') setRepertoire(rRes.value);
        if (sRes.status === 'fulfilled') {
          setStats(sRes.value);
        } else {
          const err = sRes.reason;
          const msg =
            err instanceof ApiError
              ? err.message
              : t(
                  'openingTrainer.stats.errors.loadFailed',
                  'Failed to load stats',
                );
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const formatDate = useCallback((iso: string | null): string => {
    if (!iso) {
      return t('openingTrainer.stats.session.active', 'in progress');
    }
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }, [t]);

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  return (
    <div className="opening-trainer-stats" data-testid="opening-trainer-stats">
      {id && (
        <Link to={`/opening-trainer/${id}`} className="back-link">
          ← {t('openingTrainer.stats.back', 'Back to repertoire')}
        </Link>
      )}

      <header>
        <h1>
          {t('openingTrainer.stats.title', 'Statistics')}
          {repertoire ? `: ${repertoire.title}` : ''}
        </h1>
      </header>

      {error && (
        <div className="error" data-testid="opening-trainer-stats-error">
          {error}
        </div>
      )}

      {stats && (
        <>
          <section
            className="opening-trainer-stats__summary"
            data-testid="opening-trainer-stats-summary"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 10,
              marginBottom: 24,
            }}
          >
            <div className="stat">
              <span
                className="stat__value"
                data-testid="opening-trainer-stats-accuracy"
                style={{ display: 'block', fontSize: 28, fontWeight: 700 }}
              >
                {Math.round(stats.accuracyPercent)}%
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.accuracy', 'Accuracy')}
              </span>
            </div>
            <div className="stat">
              <span
                className="stat__value"
                style={{ display: 'block', fontSize: 28, fontWeight: 700 }}
              >
                {stats.totalSessions}
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.sessionsTotal', 'Sessions')}
              </span>
            </div>
            <div className="stat">
              <span
                className="stat__value"
                style={{ display: 'block', fontSize: 28, fontWeight: 700 }}
              >
                {stats.completedSessions}
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.sessionsCompleted', 'Completed')}
              </span>
            </div>
            <div className="stat">
              <span
                className="stat__value"
                style={{ display: 'block', fontSize: 28, fontWeight: 700 }}
              >
                {stats.totalAttempts}
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.attempts', 'Attempts')}
              </span>
            </div>
            <div className="stat">
              <span
                className="stat__value"
                style={{
                  display: 'block',
                  fontSize: 28,
                  fontWeight: 700,
                  color: 'var(--success, #22c55e)',
                }}
              >
                {stats.correctAttempts}
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.correct', 'Correct')}
              </span>
            </div>
            <div className="stat">
              <span
                className="stat__value"
                style={{
                  display: 'block',
                  fontSize: 28,
                  fontWeight: 700,
                  color: 'var(--danger, #ef4444)',
                }}
              >
                {stats.wrongAttempts}
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.wrong', 'Wrong')}
              </span>
            </div>
            <div className="stat">
              <span
                className="stat__value"
                style={{ display: 'block', fontSize: 28, fontWeight: 700 }}
              >
                {stats.hintsUsed}
              </span>
              <span className="stat__label">
                {t('openingTrainer.stats.hints', 'Hints')}
              </span>
            </div>
          </section>

          <section
            className="opening-trainer-stats__errors"
            data-testid="opening-trainer-stats-errors"
            style={{ marginBottom: 24 }}
          >
            <h2>
              {t(
                'openingTrainer.stats.topErrors',
                'Where you make the most mistakes',
              )}
            </h2>
            {stats.topErrorPositions.length === 0 ? (
              <p
                data-testid="opening-trainer-stats-errors-empty"
                style={{ opacity: 0.7 }}
              >
                {t(
                  'openingTrainer.stats.topErrorsEmpty',
                  'No mistakes recorded yet — keep training.',
                )}
              </p>
            ) : (
              <ol
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {stats.topErrorPositions.map((row, idx) => (
                  <ErrorRow
                    key={`${row.positionFen}-${idx}`}
                    row={row}
                    orientation={repertoire?.side ?? 'white'}
                    t={t}
                  />
                ))}
              </ol>
            )}
          </section>

          <section
            className="opening-trainer-stats__sessions"
            data-testid="opening-trainer-stats-sessions"
          >
            <h2>{t('openingTrainer.stats.lastSessions', 'Recent sessions')}</h2>
            {stats.lastSessions.length === 0 ? (
              <p
                data-testid="opening-trainer-stats-sessions-empty"
                style={{ opacity: 0.7 }}
              >
                {t(
                  'openingTrainer.stats.lastSessionsEmpty',
                  'No sessions yet.',
                )}
              </p>
            ) : (
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {stats.lastSessions.map((s) => (
                  <li
                    key={s.id}
                    data-testid="opening-trainer-stats-session-row"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '8px 12px',
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                      fontSize: 13,
                    }}
                  >
                    <span>{formatDate(s.finishedAt)}</span>
                    <span>
                      {t('openingTrainer.stats.session.score', 'Score')}:{' '}
                      <strong>{s.score}</strong>
                    </span>
                    <span>
                      {t('openingTrainer.stats.session.accuracy', 'Accuracy')}:{' '}
                      <strong>{Math.round(s.accuracy * 100)}%</strong>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
