import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseAuthorDto } from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';

/**
 * `PlayersAuthorsTab` — четвёртый таб «Authors» на `/players`
 * (KS-1920, ADR-030 §2.3).
 *
 * Полный список авторов курсов с пагинацией. Кнопка «All authors»
 * из `CourseAuthorsBlock` (KS-1919) ведёт сюда (`/players?tab=authors`).
 *
 * # Infinite scroll
 *
 * Загружаем `limit=50` страницами через `IntersectionObserver` на
 * sentinel-элементе в конце таблицы. Пока `data.length < total` —
 * следующий fetch с `offset=loadedCount`. Sentinel и observer
 * disconnect'ятся при размонтировании / смене сорта.
 *
 * # Sort
 *
 * Two-way toggle: `'courses'` (default) / `'recent'`. Смена сорта
 * сбрасывает таблицу и стартует с offset=0.
 *
 * # Empty / error
 *
 * Empty: backend вернул 0 авторов → показываем «No course authors
 * yet» с подсказкой. Error: сетевой сбой → стандартный error-state
 * со «Try again»-кнопкой.
 */

const PAGE_SIZE = 50;

type Sort = 'courses' | 'recent';

function formatRelative(iso: string, locale: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PlayersAuthorsTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';

  const [sort, setSort] = useState<Sort>('courses');
  const [authors, setAuthors] = useState<CourseAuthorDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errored, setErrored] = useState(false);

  const sentinelRef = useRef<HTMLTableRowElement | null>(null);
  const fetchTokenRef = useRef(0);

  const fetchPage = useCallback(
    async (
      currentSort: Sort,
      offset: number,
    ): Promise<{ data: CourseAuthorDto[]; total: number } | null> => {
      try {
        const res = await userCoursesApi.listAuthors({
          sort: currentSort,
          limit: PAGE_SIZE,
          offset,
        });
        return { data: res.data ?? [], total: res.total ?? 0 };
      } catch {
        return null;
      }
    },
    [],
  );

  // Первая загрузка / смена сорта.
  useEffect(() => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    setErrored(false);
    setAuthors([]);
    setTotal(0);
    fetchPage(sort, 0).then((res) => {
      if (token !== fetchTokenRef.current) return;
      if (!res) {
        setErrored(true);
        setLoading(false);
        return;
      }
      setAuthors(res.data);
      setTotal(res.total);
      setLoading(false);
    });
  }, [sort, fetchPage]);

  const hasMore = authors.length < total;

  // Infinite scroll через IntersectionObserver.
  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      const token = fetchTokenRef.current;
      setLoadingMore(true);
      void fetchPage(sort, authors.length).then((res) => {
        if (token !== fetchTokenRef.current) return;
        if (!res) {
          setErrored(true);
          setLoadingMore(false);
          return;
        }
        setAuthors((prev) => [...prev, ...res.data]);
        setTotal(res.total);
        setLoadingMore(false);
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, authors.length, sort, fetchPage]);

  const retry = () => {
    setSort((s) => s); // не меняем sort, но триггерим useEffect через токен
    fetchTokenRef.current++;
    setErrored(false);
    setLoading(true);
    void fetchPage(sort, 0).then((res) => {
      if (!res) {
        setErrored(true);
        setLoading(false);
        return;
      }
      setAuthors(res.data);
      setTotal(res.total);
      setLoading(false);
    });
  };

  const sortLabels = useMemo(
    () => ({
      courses: t('players.authors.sort.courses', 'Most courses'),
      recent: t('players.authors.sort.recent', 'Recently updated'),
    }),
    [t],
  );

  return (
    <div className="players-authors-tab" data-testid="players-authors-tab">
      <header className="players-authors-tab__header">
        <div
          className="players-authors-tab__sort"
          role="tablist"
          aria-label={t('players.authors.sortLabel', 'Sort')}
        >
          <button
            type="button"
            className={`players-authors-tab__sort-btn${sort === 'courses' ? ' active' : ''}`}
            onClick={() => setSort('courses')}
            aria-pressed={sort === 'courses'}
            data-testid="players-authors-sort-courses"
          >
            {sortLabels.courses}
          </button>
          <button
            type="button"
            className={`players-authors-tab__sort-btn${sort === 'recent' ? ' active' : ''}`}
            onClick={() => setSort('recent')}
            aria-pressed={sort === 'recent'}
            data-testid="players-authors-sort-recent"
          >
            {sortLabels.recent}
          </button>
        </div>
        {total > 0 && (
          <span
            className="players-authors-tab__total"
            data-testid="players-authors-total"
          >
            {t('players.authors.showing', {
              shown: authors.length,
              total,
              defaultValue: 'Showing {{shown}} of {{total}}',
            })}
          </span>
        )}
      </header>

      {errored && (
        <div
          className="players-authors-tab__error"
          data-testid="players-authors-error"
          role="alert"
        >
          <span>
            {t('players.authors.error', 'Failed to load authors')}
          </span>
          <button type="button" onClick={retry}>
            {t('players.authors.retry', 'Try again')}
          </button>
        </div>
      )}

      {!errored && loading && (
        <div
          className="players-authors-tab__loading"
          data-testid="players-authors-loading"
        >
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {!errored && !loading && authors.length === 0 && (
        <div
          className="players-empty"
          data-testid="players-authors-empty"
        >
          {t('players.authors.empty', 'No course authors yet')}
        </div>
      )}

      {!errored && !loading && authors.length > 0 && (
        <table className="players-table players-authors-table">
          <thead>
            <tr>
              <th>{t('players.authors.col.author', 'Author')}</th>
              <th>{t('players.authors.col.courses', 'Courses')}</th>
              <th>{t('players.authors.col.updated', 'Last updated')}</th>
            </tr>
          </thead>
          <tbody>
            {authors.map((a) => (
              <tr
                key={a.user.id}
                data-testid={`players-authors-row-${a.user.id}`}
              >
                <td>
                  <Link
                    to={`/player/${encodeURIComponent(a.user.username)}`}
                    className="players-link"
                    data-testid={`players-authors-link-${a.user.id}`}
                  >
                    <span
                      className="players-authors-tab__avatar"
                      aria-hidden="true"
                    >
                      {a.user.avatarUrl ? (
                        <img src={a.user.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="players-authors-tab__avatar-fallback">
                          {a.user.username.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <span>{a.user.displayName || a.user.username}</span>
                  </Link>
                </td>
                <td className="players-authors-tab__count">
                  {a.publicCoursesCount}
                </td>
                <td>{formatRelative(a.lastCourseUpdatedAt, locale)}</td>
              </tr>
            ))}
            {hasMore && (
              <tr
                ref={sentinelRef}
                className="players-authors-tab__sentinel"
                data-testid="players-authors-sentinel"
                aria-hidden="true"
              >
                <td colSpan={3}>
                  {loadingMore
                    ? t('common.loading', 'Loading…')
                    : '\u00a0'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
