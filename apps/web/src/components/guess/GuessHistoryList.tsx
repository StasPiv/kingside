import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GuessHistoryResponse } from '@kingside/shared';
import { api } from '../../api';
import { guessApi } from '../../api/guessApi';

/**
 * KS-3510 (ADR-093 §3.4) — список finished-сессий пользователя.
 * Источник — `GET /guess/history?limit=&offset=`. Пагинация offset
 * (backend отдаёт total).
 *
 * Каждая строка ведёт в `/guess/sessions/:id` (review) — там уже
 * есть существующая страница revisит сессии (ADR-086).
 */

const PAGE_SIZE = 20;

export interface GuessHistoryListProps {
  fetcher?: (offset: number, limit: number) => Promise<GuessHistoryResponse>;
  /**
   * KS-3513 DI для тестов — подменяет guessApi.toAnalysis при клике
   * по строке. По умолчанию `guessApi.toAnalysis` (KS-3461): backend
   * создаёт/возвращает Analysis по сессии и отдаёт `url=/analysis/:id`.
   */
  toAnalysis?: (sessionId: string) => Promise<{ url: string }>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function GuessHistoryList({
  fetcher,
  toAnalysis,
}: GuessHistoryListProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<GuessHistoryResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // KS-3513: одна сессия открывается за раз; пока идёт POST'у /to-analysis,
  // блокируем строку, чтобы пользователь не дёргал её дважды.
  const [openingId, setOpeningId] = useState<string | null>(null);

  // KS-3513: клик по строке → guessApi.toAnalysis(id) → navigate(url).
  // /to-analysis (KS-3461) идемпотентен через Analysis.guessSessionId
  // UNIQUE: повторный клик отдаёт existing=true и тот же analysisId.
  // Ошибка — снимаем loading + console.warn (полноценный notice — за L1).
  const openSession = useCallback(
    async (sessionId: string) => {
      if (openingId) return;
      setOpeningId(sessionId);
      try {
        const call = toAnalysis ?? ((id: string) => guessApi.toAnalysis(id));
        const res = await call(sessionId);
        navigate(res.url);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[guess-history] toAnalysis failed', e);
        setOpeningId(null);
      }
    },
    [openingId, navigate, toAnalysis],
  );

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const get =
        fetcher ??
        ((o: number, l: number) =>
          api.get<GuessHistoryResponse>(
            `/guess/history?limit=${l}&offset=${o}`,
          ));
      const res = await get(offset, PAGE_SIZE);
      setData(res);
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetcher, offset]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  if (loading) {
    return (
      <section
        className="guess-history"
        data-testid="guess-history"
        data-state="loading"
      >
        <div
          className="guess-history__skeleton"
          data-testid="guess-history-skeleton"
        />
      </section>
    );
  }
  if (error) {
    return (
      <section
        className="guess-history"
        data-testid="guess-history"
        data-state="error"
      >
        <p>{t('guess.history.error', 'Failed to load history')}</p>
        <button type="button" onClick={() => void doFetch()}>
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }
  if (!data || data.items.length === 0) {
    return (
      <section
        className="guess-history"
        data-testid="guess-history"
        data-state="empty"
      >
        <p
          className="guess-history__placeholder"
          data-testid="guess-history-placeholder"
        >
          {t('guess.history.empty', 'No finished sessions yet')}
        </p>
      </section>
    );
  }

  const total = data.total;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <section
      className="guess-history"
      data-testid="guess-history"
      data-state="ready"
      data-total={String(total)}
    >
      <ol className="guess-history__list">
        {data.items.map((s) => {
          const isOpening = openingId === s.id;
          return (
            <li
              key={s.id}
              className="guess-history__item"
              data-testid={`guess-history-item-${s.id}`}
              data-status={s.status}
            >
              {/* KS-3513: вместо Link на несуществующий /guess/sessions/:id
                  делаем button → guessApi.toAnalysis → navigate(url).
                  Этот endpoint уже работал в финал-экране (KS-3461);
                  идемпотентен по UNIQUE(guessSessionId). */}
              <button
                type="button"
                className="guess-history__link"
                data-testid={`guess-history-link-${s.id}`}
                disabled={isOpening || openingId !== null}
                aria-busy={isOpening}
                onClick={() => void openSession(s.id)}
              >
                <span className="guess-history__date">
                  {fmtDate(s.finishedAt ?? s.startedAt)}
                </span>
                <span className="guess-history__side">
                  {t(`guess.setup.${s.side}`, s.side)}
                </span>
                <span className="guess-history__acc">
                  {s.userAccuracy != null
                    ? `${Math.round(s.userAccuracy)}%`
                    : '—'}
                </span>
                <span className="guess-history__stars">
                  {s.userStars != null ? `${s.userStars}★` : '—'}
                </span>
                <span className="guess-history__score">{s.score}</span>
                {isOpening && (
                  <span
                    className="guess-history__opening"
                    data-testid={`guess-history-opening-${s.id}`}
                  >
                    {t('guess.history.opening', 'Opening…')}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <footer
        className="guess-history__pagination"
        data-testid="guess-history-pagination"
      >
        <button
          type="button"
          data-testid="guess-history-prev"
          disabled={!hasPrev}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
        >
          {t('common.prev', 'Prev')}
        </button>
        <span className="guess-history__page-info">
          {t('guess.history.pageInfo', {
            defaultValue: '{{from}}–{{to}} of {{total}}',
            from: total === 0 ? 0 : offset + 1,
            to: Math.min(offset + PAGE_SIZE, total),
            total,
          })}
        </span>
        <button
          type="button"
          data-testid="guess-history-next"
          disabled={!hasNext}
          onClick={() => setOffset((o) => o + PAGE_SIZE)}
        >
          {t('common.next', 'Next')}
        </button>
      </footer>
    </section>
  );
}
