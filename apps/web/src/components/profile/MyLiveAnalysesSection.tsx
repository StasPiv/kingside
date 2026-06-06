import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LiveAnalysisListItem } from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';

/**
 * KS-3738 / ADR-110 §8. Секция «Мои live-трансляции» в профиле.
 *
 * Загружает `GET /live-analyses/me` и показывает два блока:
 *   - Активные: ссылка для копирования + кнопка «Завершить» (вызывает
 *     `DELETE /live-analyses/:slug`).
 *   - Завершённые: последние 10, без действий, slug + даты старта/закрытия.
 *
 * Гейт «только на своём профиле» — на стороне родителя
 * (PlayerProfilePage условно рендерит компонент, если
 * `currentUser.id === profile.id`).
 *
 * Формат ответа `/live-analyses/me` (ADR-110 §8): объект с полями
 * `active: LiveAnalysisListItem[]` и `closed: LiveAnalysisListItem[]`.
 * На случай если backend отдаст плоский массив (variant B по итогу
 * ревью контракта) — поддерживаем оба варианта без падений.
 */

type MyLiveAnalysesResponse =
  | LiveAnalysisListItem[]
  | {
      active?: LiveAnalysisListItem[];
      closed?: LiveAnalysisListItem[];
    };

function splitByStatus(payload: MyLiveAnalysesResponse): {
  active: LiveAnalysisListItem[];
  closed: LiveAnalysisListItem[];
} {
  if (Array.isArray(payload)) {
    const active: LiveAnalysisListItem[] = [];
    const closed: LiveAnalysisListItem[] = [];
    for (const item of payload) {
      if (item.status === 'active') active.push(item);
      else closed.push(item);
    }
    return { active, closed };
  }
  return {
    active: payload.active ?? [],
    closed: payload.closed ?? [],
  };
}

function buildPublicUrl(slug: string): string {
  if (typeof window === 'undefined') {
    return `/live/${slug}`;
  }
  // На любом окружении (kingside.site / staging / localhost) формируем
  // ссылку через origin, чтобы пользователь мог поделиться ей не задумываясь.
  return `${window.location.origin}/live/${slug}`;
}

function formatDate(dateStr: string | null, locale: string): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function MyLiveAnalysesSection() {
  const { t, i18n } = useTranslation();
  const [active, setActive] = useState<LiveAnalysisListItem[]>([]);
  const [closed, setClosed] = useState<LiveAnalysisListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [stoppingSlug, setStoppingSlug] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<MyLiveAnalysesResponse>('/live-analyses/me')
      .then((resp) => {
        if (cancelled) return;
        const split = splitByStatus(resp);
        setActive(split.active);
        // Показываем только последние 10 закрытых — это backlog для
        // самоконтроля автора, не полноценная история.
        setClosed(split.closed.slice(0, 10));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof ApiError ? e.message : 'load-failed';
        setError(msg);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  const handleCopy = useCallback(async (slug: string) => {
    try {
      await navigator.clipboard.writeText(buildPublicUrl(slug));
      setCopiedSlug(slug);
      window.setTimeout(() => {
        // Сравнение через функтор гарантирует, что если за 2.5с был
        // скопирован другой slug — не сбрасываем его подсветку.
        setCopiedSlug((curr) => (curr === slug ? null : curr));
      }, 2500);
    } catch {
      /* clipboard может быть закрыт permissions — игнор */
    }
  }, []);

  const handleStop = useCallback(
    async (slug: string) => {
      // confirm() — простой синхронный гейт от случайного клика.
      // ADR-110 §3 говорит, что закрытие необратимо: переоткрыть
      // трансляцию по тому же slug нельзя, нужен новый POST.
      if (typeof window !== 'undefined' && !window.confirm(
        t('myLiveAnalyses.stopConfirm', 'Stop this broadcast?'),
      )) {
        return;
      }
      setStoppingSlug(slug);
      try {
        await api.delete<void>(`/live-analyses/${slug}`);
        // Локально перекидываем в closed и снимаем из active без
        // повторного запроса — UX отзывчивее.
        setActive((prev) => prev.filter((item) => item.slug !== slug));
        // Не добавляем item в closed автоматически: у нас нет
        // `closedAt`-времени без round-trip'а на сервер. Делаем
        // ленивый перезапрос, чтобы closed-список тоже обновился.
        load();
      } catch {
        // Молча: пользователь увидит, что строка не пропала, и сможет
        // повторить. Полноценный тост — за рамками MVP-секции.
      } finally {
        setStoppingSlug(null);
      }
    },
    [load, t],
  );

  const hasContent = useMemo(
    () => active.length > 0 || closed.length > 0,
    [active.length, closed.length],
  );

  if (loading) {
    return (
      <div className="my-live-analyses my-live-analyses--loading">
        <h2>{t('myLiveAnalyses.title', 'My live broadcasts')}</h2>
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="my-live-analyses my-live-analyses--error"
        data-testid="my-live-analyses-error"
      >
        <h2>{t('myLiveAnalyses.title', 'My live broadcasts')}</h2>
        <p>{t('myLiveAnalyses.loadError', 'Failed to load your broadcasts.')}</p>
      </div>
    );
  }

  return (
    <section
      className="my-live-analyses"
      data-testid="my-live-analyses"
    >
      <h2>{t('myLiveAnalyses.title', 'My live broadcasts')}</h2>

      <div className="my-live-analyses__block">
        <h3>{t('myLiveAnalyses.activeHeading', 'Active')}</h3>
        {active.length === 0 ? (
          <p
            className="my-live-analyses__empty"
            data-testid="my-live-analyses-active-empty"
          >
            {t('myLiveAnalyses.emptyActive', 'You have no active broadcasts.')}
          </p>
        ) : (
          <ul
            className="my-live-analyses__list"
            data-testid="my-live-analyses-active-list"
          >
            {active.map((item) => {
              const publicUrl = buildPublicUrl(item.slug);
              return (
                <li
                  key={item.id}
                  className="my-live-analyses__item my-live-analyses__item--active"
                >
                  <div className="my-live-analyses__row">
                    <Link
                      to={`/live/${item.slug}`}
                      className="my-live-analyses__title-link"
                    >
                      {item.title || `/live/${item.slug}`}
                    </Link>
                    <span className="my-live-analyses__date">
                      {t('myLiveAnalyses.startedAt', 'Started')}:{' '}
                      {formatDate(item.createdAt, i18n.language)}
                    </span>
                  </div>
                  <div className="my-live-analyses__row">
                    <code
                      className="my-live-analyses__url"
                      data-testid="my-live-analyses-url"
                    >
                      {publicUrl}
                    </code>
                    <button
                      type="button"
                      className="my-live-analyses__copy"
                      data-testid="my-live-analyses-copy"
                      onClick={() => void handleCopy(item.slug)}
                    >
                      {copiedSlug === item.slug
                        ? t('myLiveAnalyses.copied', 'Copied')
                        : t('myLiveAnalyses.copyLink', 'Copy link')}
                    </button>
                    <button
                      type="button"
                      className="my-live-analyses__stop"
                      data-testid="my-live-analyses-stop"
                      onClick={() => void handleStop(item.slug)}
                      disabled={stoppingSlug === item.slug}
                    >
                      {stoppingSlug === item.slug
                        ? t('myLiveAnalyses.stopping', 'Stopping…')
                        : t('myLiveAnalyses.stop', 'Stop')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="my-live-analyses__block">
        <h3>{t('myLiveAnalyses.closedHeading', 'Recent')}</h3>
        {closed.length === 0 ? (
          <p
            className="my-live-analyses__empty"
            data-testid="my-live-analyses-closed-empty"
          >
            {t('myLiveAnalyses.emptyClosed', 'No past broadcasts yet.')}
          </p>
        ) : (
          <ul
            className="my-live-analyses__list"
            data-testid="my-live-analyses-closed-list"
          >
            {closed.map((item) => (
              <li
                key={item.id}
                className="my-live-analyses__item my-live-analyses__item--closed"
              >
                <div className="my-live-analyses__row">
                  <span className="my-live-analyses__title">
                    {item.title || `/live/${item.slug}`}
                  </span>
                  <span className="my-live-analyses__viewer-peak">
                    {t('myLiveAnalyses.viewerPeak', 'Peak viewers')}:{' '}
                    {item.viewerPeak}
                  </span>
                </div>
                <div className="my-live-analyses__row my-live-analyses__row--meta">
                  <span>
                    {t('myLiveAnalyses.startedAt', 'Started')}:{' '}
                    {formatDate(item.createdAt, i18n.language)}
                  </span>
                  <span>
                    {t('myLiveAnalyses.closedAt', 'Closed')}:{' '}
                    {formatDate(item.closedAt, i18n.language)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!hasContent && null}
    </section>
  );
}
