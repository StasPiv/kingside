import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardAttemptDto,
  BlindBoardPieceType,
  BlindBoardSessionReviewResponse,
} from '@kingside/shared';
import { BlindBoardSubNav } from '../components/blindBoard/BlindBoardSubNav';
import { BlindBoardPieceIcon } from '../components/blindBoard/BlindBoardPieceIcon';
import { blindBoardApi } from '../api/blindBoardApi';

/**
 * KS-3517 (ADR-093 §4 follow-up) — review одной blind-board сессии.
 *
 * Backend: `GET /blind-board/sessions/:id` (282ac910) отдаёт
 * `BlindBoardSessionReviewResponse` — session, snapshot config,
 * attempts[] (per-round), + `startPosition` для finished (для active
 * НЕ раскрывается, см. анти-чит §5).
 *
 * Страница показывает:
 *  1. Заголовок + статус + длительность.
 *  2. 6 метрик-карточек: level, bestStreak, finishReason, % правильных,
 *     rounds, currentStreak (для active интересен текущий).
 *  3. Конфиг (startPieces, addOrder, memorizeTimeSec).
 *  4. Список раундов (attempts) с маркером correct/incorrect.
 *  5. Start position (только если finished — backend контрактно
 *     гарантирует наличие startPosition только в этом случае).
 *
 * Доска самой позиции не рендерится через react-chessboard внутри
 * этой задачи (нужен CSS-aware размер) — выводим компактный список
 * «icon + square». Layout-этап KS-3518/L1 может развернуть в полноценную
 * доску, передав startPosition.
 */

export interface BlindBoardSessionReviewPageProps {
  /** DI для тестов. */
  getSession?: (id: string) => Promise<BlindBoardSessionReviewResponse>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function BlindBoardSessionReviewPage({
  getSession,
}: BlindBoardSessionReviewPageProps = {}) {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();

  const [data, setData] = useState<BlindBoardSessionReviewResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSession = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const get =
        getSession ?? ((sid: string) => blindBoardApi.getSession(sid));
      setData(await get(id));
    } catch (e) {
      // KS-3526: явный console.error (раньше его не было) — облегчает
      // диагностику белого экрана у юзера: причина видна в DevTools
      // даже до того, как мы прокинули детальный error-state.
      // eslint-disable-next-line no-console
      console.error('[blind-board-review] getSession failed', e);
      setError(
        e instanceof Error
          ? e.message
          : t('blindBoard.review.error', 'Failed to load session'),
      );
    } finally {
      setLoading(false);
    }
  }, [id, getSession, t]);

  useEffect(() => {
    void fetchSession();
  }, [fetchSession]);

  // KS-3526: defensive — backend в редких случаях (legacy сессии без
  // snapshot config / unhandled поле) может вернуть `attempts: null`,
  // `config: null` или `startPosition: null`. До хотфикса любой такой
  // случай ронял рендер на `.map()/.filter()` → React выкидывал весь
  // дерево, пользователь видел белый экран. Нормализуем тут один раз.
  const attempts = useMemo(() => data?.attempts ?? [], [data]);
  const config = useMemo(
    () =>
      data?.config ?? { startPieces: [], addOrder: [], memorizeTimeSec: 0 },
    [data],
  );
  const startPosition = useMemo(
    () => data?.startPosition ?? undefined,
    [data],
  );

  const correctCount = useMemo(
    () => attempts.filter((a) => a.correct).length,
    [attempts],
  );

  if (loading) {
    return (
      <div
        className="blind-board-review-page"
        data-testid="blind-board-review-page"
        data-state="loading"
      >
        <BlindBoardSubNav />
        <div className="blind-board-review-page__skeleton" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="blind-board-review-page"
        data-testid="blind-board-review-page"
        data-state="error"
      >
        <BlindBoardSubNav />
        <header className="blind-board-review-page__header">
          <Link
            to="/blind-board/history"
            className="blind-board-review-page__back"
          >
            ← {t('blindBoard.review.backToHistory', 'Back to history')}
          </Link>
        </header>
        <p data-testid="blind-board-review-error">
          {error ?? t('blindBoard.review.error', 'Failed to load session')}
        </p>
        <button type="button" onClick={() => void fetchSession()}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  const { session } = data;
  const totalRounds = attempts.length;
  const accuracyPct =
    totalRounds > 0 ? Math.round((correctCount / totalRounds) * 100) : null;
  const duration = fmtDuration(session.startedAt, session.finishedAt);

  return (
    <div
      className="blind-board-review-page"
      data-testid="blind-board-review-page"
      data-state="ready"
      data-status={session.status}
    >
      <BlindBoardSubNav />

      <header className="blind-board-review-page__header">
        <Link
          to="/blind-board/history"
          className="blind-board-review-page__back"
          data-testid="blind-board-review-back"
        >
          ← {t('blindBoard.review.backToHistory', 'Back to history')}
        </Link>
        <h1
          className="blind-board-review-page__title"
          data-testid="blind-board-review-title"
        >
          {t('blindBoard.review.titleSession', {
            defaultValue: 'Session of {{date}}',
            date: fmtDate(session.startedAt),
          })}
        </h1>
        <p
          className="blind-board-review-page__meta"
          data-testid="blind-board-review-meta"
        >
          <span data-testid="blind-board-review-status">
            {t(
              `blindBoard.review.status.${session.status}`,
              session.status,
            )}
          </span>
          {' · '}
          <span data-testid="blind-board-review-duration">
            {t('blindBoard.review.duration', 'Duration')}: {duration}
          </span>
        </p>
      </header>

      <section
        className="blind-board-review-page__metrics"
        data-testid="blind-board-review-metrics"
      >
        <div
          className="blind-board-review-page__metric"
          data-testid="blind-board-review-metric-level"
        >
          <div className="blind-board-review-page__metric-value">
            L{session.level ?? 1}
          </div>
          <div className="blind-board-review-page__metric-label">
            {t('blindBoard.review.level', 'Level')}
          </div>
        </div>
        <div
          className="blind-board-review-page__metric"
          data-testid="blind-board-review-metric-best-streak"
        >
          <div className="blind-board-review-page__metric-value">
            {session.bestStreak}
          </div>
          <div className="blind-board-review-page__metric-label">
            {t('blindBoard.review.bestStreak', 'Best streak')}
          </div>
        </div>
        <div
          className="blind-board-review-page__metric"
          data-testid="blind-board-review-metric-current-streak"
        >
          <div className="blind-board-review-page__metric-value">
            {session.streak}
          </div>
          <div className="blind-board-review-page__metric-label">
            {t('blindBoard.review.currentStreak', 'Current streak')}
          </div>
        </div>
        <div
          className="blind-board-review-page__metric"
          data-testid="blind-board-review-metric-accuracy"
        >
          <div className="blind-board-review-page__metric-value">
            {accuracyPct == null ? '—' : `${accuracyPct}%`}
          </div>
          <div className="blind-board-review-page__metric-label">
            {t('blindBoard.review.accuracy', 'Correct')}
          </div>
          <div className="blind-board-review-page__metric-hint">
            {correctCount} / {totalRounds}
          </div>
        </div>
        <div
          className="blind-board-review-page__metric"
          data-testid="blind-board-review-metric-rounds"
        >
          <div className="blind-board-review-page__metric-value">
            {totalRounds}
          </div>
          <div className="blind-board-review-page__metric-label">
            {t('blindBoard.review.rounds', 'Rounds')}
          </div>
        </div>
        <div
          className="blind-board-review-page__metric"
          data-testid="blind-board-review-metric-finish-reason"
        >
          <div className="blind-board-review-page__metric-value">
            {session.finishReason
              ? t(
                  `blindBoard.history.reason.${session.finishReason}`,
                  session.finishReason,
                )
              : '—'}
          </div>
          <div className="blind-board-review-page__metric-label">
            {t('blindBoard.review.finishReason', 'Finish reason')}
          </div>
        </div>
      </section>

      <section
        className="blind-board-review-page__config"
        data-testid="blind-board-review-config"
      >
        <h2 className="blind-board-review-page__section-title">
          {t('blindBoard.review.configTitle', 'Session config')}
        </h2>
        <div className="blind-board-review-page__config-row">
          <span className="blind-board-review-page__config-label">
            {t('blindBoard.review.startPieces', 'Starting pieces')}:
          </span>
          <span
            className="blind-board-review-page__pieces"
            data-testid="blind-board-review-config-start"
          >
            {config.startPieces.length === 0
              ? '—'
              : config.startPieces.map(
                  (p: BlindBoardPieceType, i: number) => (
                    <span
                      key={`s-${i}`}
                      className="blind-board-review-page__piece"
                      data-piece={p}
                      aria-label={t(`blindBoard.piece.${p}`, p)}
                    >
                      <BlindBoardPieceIcon pieceType={p} />
                    </span>
                  ),
                )}
          </span>
        </div>
        <div className="blind-board-review-page__config-row">
          <span className="blind-board-review-page__config-label">
            {t('blindBoard.review.addOrder', 'Add order')}:
          </span>
          <span
            className="blind-board-review-page__pieces"
            data-testid="blind-board-review-config-add"
          >
            {config.addOrder.length === 0
              ? '—'
              : config.addOrder.map(
                  (p: BlindBoardPieceType, i: number) => (
                    <span
                      key={`a-${i}`}
                      className="blind-board-review-page__piece"
                      data-piece={p}
                      aria-label={t(`blindBoard.piece.${p}`, p)}
                    >
                      <BlindBoardPieceIcon pieceType={p} />
                    </span>
                  ),
                )}
          </span>
        </div>
        <div className="blind-board-review-page__config-row">
          <span className="blind-board-review-page__config-label">
            {t('blindBoard.review.memorizeTime', 'Memorize time')}:
          </span>
          <span
            className="blind-board-review-page__config-value"
            data-testid="blind-board-review-config-memorize"
          >
            {config.memorizeTimeSec}s
          </span>
        </div>
      </section>

      <section
        className="blind-board-review-page__attempts"
        data-testid="blind-board-review-attempts"
      >
        <h2 className="blind-board-review-page__section-title">
          {t('blindBoard.review.attemptsTitle', 'Rounds')}
        </h2>
        {attempts.length === 0 ? (
          <p
            className="blind-board-review-page__attempts-empty"
            data-testid="blind-board-review-attempts-empty"
          >
            {t('blindBoard.review.attemptsEmpty', 'No rounds yet')}
          </p>
        ) : (
          <ol className="blind-board-review-page__attempts-list">
            {attempts.map((a: BlindBoardAttemptDto) => (
              <li
                key={a.round}
                className={`blind-board-review-page__attempt blind-board-review-page__attempt--${a.correct ? 'correct' : 'incorrect'}`}
                data-testid={`blind-board-review-attempt-${a.round}`}
                data-correct={a.correct ? 'true' : 'false'}
              >
                <span className="blind-board-review-page__attempt-round">
                  {t('blindBoard.review.roundN', {
                    defaultValue: 'Round {{n}}',
                    n: a.round,
                  })}
                </span>
                <span className="blind-board-review-page__attempt-move">
                  {a.compMove.from} → {a.compMove.to}
                </span>
                <span className="blind-board-review-page__attempt-expected">
                  <span
                    className="blind-board-review-page__attempt-icon"
                    aria-label={t(
                      `blindBoard.piece.${a.expectedPieceType}`,
                      a.expectedPieceType,
                    )}
                  >
                    <BlindBoardPieceIcon
                      pieceType={a.expectedPieceType}
                    />
                  </span>
                  <span className="blind-board-review-page__attempt-square">
                    @{a.expectedSquare}
                  </span>
                </span>
                <span className="blind-board-review-page__attempt-user">
                  {a.userPieceType && a.userSquare ? (
                    <>
                      <span
                        className="blind-board-review-page__attempt-icon"
                        aria-label={t(
                          `blindBoard.piece.${a.userPieceType}`,
                          a.userPieceType,
                        )}
                      >
                        <BlindBoardPieceIcon
                          pieceType={a.userPieceType}
                        />
                      </span>
                      <span className="blind-board-review-page__attempt-square">
                        @{a.userSquare}
                      </span>
                    </>
                  ) : (
                    <span
                      className="blind-board-review-page__attempt-open"
                      data-testid={`blind-board-review-attempt-open-${a.round}`}
                    >
                      {t('blindBoard.review.attemptOpen', '(open)')}
                    </span>
                  )}
                </span>
                <span
                  className={`blind-board-review-page__attempt-mark blind-board-review-page__attempt-mark--${a.correct ? 'correct' : 'incorrect'}`}
                  data-testid={`blind-board-review-attempt-mark-${a.round}`}
                >
                  {a.correct
                    ? t('blindBoard.review.correct', '✓ Correct')
                    : t('blindBoard.review.incorrect', '✗ Incorrect')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        className="blind-board-review-page__position"
        data-testid="blind-board-review-position"
      >
        <h2 className="blind-board-review-page__section-title">
          {t('blindBoard.review.positionTitle', 'Start position')}
        </h2>
        {startPosition && startPosition.length > 0 ? (
          <div
            className="blind-board-review-page__position-list"
            data-testid="blind-board-review-position-list"
          >
            {startPosition.map((p, i) => (
              <span
                key={`${p.square}-${i}`}
                className="blind-board-review-page__position-piece"
                data-piece={p.type}
                data-square={p.square}
              >
                <BlindBoardPieceIcon pieceType={p.type} />
                <span className="blind-board-review-page__position-square">
                  @{p.square}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <p
            className="blind-board-review-page__position-hidden"
            data-testid="blind-board-review-position-hidden"
          >
            {session.status === 'finished'
              ? t(
                  'blindBoard.review.positionUnavailable',
                  'Start position is not available for this session',
                )
              : t(
                  'blindBoard.review.positionLocked',
                  'Position will be revealed after the session ends',
                )}
          </p>
        )}
      </section>
    </div>
  );
}
