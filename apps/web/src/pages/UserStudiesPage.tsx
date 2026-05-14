import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import {
  studiesApi,
  type StudyDto,
  type StudyByUserResponse,
} from '../api/studiesApi';
import { StudyCatalogCard } from '../components/studies/StudyCatalogCard';

/**
 * KS-2889 / ADR-060 §3.4 K6 (FC4) — `/studies/by/:userId`.
 *
 * Страница со студиями конкретного автора. Backend B8 отдаёт
 * `{items, total, hasMore, owner}`; anon видит только public-студии,
 * владелец с тогглом `?includePrivate=1` — все свои (включая
 * private/unlisted).
 *
 * Toggle «Включить приватные» виден только владельцу (currentUserId
 * === userId). При его включении дописываем `?includePrivate=1` в
 * URL, чтобы reload/back/forward сохраняли состояние.
 *
 * Пагинация — infinite scroll по тому же паттерну, что StudiesPage
 * (KS-2886): IntersectionObserver на sentinel + `loadMore` с
 * `?page=N`, остановка по `hasMore=false`.
 *
 * Ссылка «Studies» на профиле пользователя ведёт сюда (см. правки в
 * `PlayerProfilePage`).
 */

export function UserStudiesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { userId } = useParams<{ userId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const includePrivate = searchParams.get('includePrivate') === '1';
  const isOwner = Boolean(
    user && userId && user.id === userId,
  );
  // Toggle включаем в payload только для владельца — backend всё
  // равно отбросит чужие includePrivate, но не нагружаем сервер
  // явно-неавторизованным запросом.
  const effectiveIncludePrivate = isOwner && includePrivate;

  const [items, setItems] = useState<StudyDto[]>([]);
  const [owner, setOwner] = useState<{
    id: string;
    username: string;
  } | null>(null);
  const [pageState, setPageState] = useState<
    'idle' | 'loading' | 'ready' | 'empty' | 'error'
  >('idle');
  // KS-3011 hotfix: backend требует `page≥1` (1-based).
  const [page, setPage] = useState<number>(1);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  useEffect(() => {
    if (!owner) return;
    const prev = document.title;
    document.title = `${owner.username} — ${t('studies.title', 'Studies')} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [owner, t]);

  const fetchFirstPage = useCallback(async () => {
    if (!userId) return;
    setPageState('loading');
    // KS-3011: 1-based; первый запрос — page=1.
    setPage(1);
    try {
      const resp: StudyByUserResponse = await studiesApi.listByUser(userId, {
        includePrivate: effectiveIncludePrivate,
        page: 1,
      });
      setItems(resp.items);
      setOwner(resp.owner);
      setHasMore(resp.hasMore);
      setPageState(resp.items.length === 0 ? 'empty' : 'ready');
    } catch {
      setItems([]);
      setHasMore(false);
      setPageState('error');
    }
  }, [userId, effectiveIncludePrivate]);

  useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(async () => {
    if (!userId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    try {
      const resp = await studiesApi.listByUser(userId, {
        includePrivate: effectiveIncludePrivate,
        page: nextPage,
      });
      setItems((prev) => [...prev, ...resp.items]);
      setHasMore(resp.hasMore);
      setPage(nextPage);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [userId, loadingMore, hasMore, page, effectiveIncludePrivate]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            void loadMore();
          }
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const togglePrivate = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (includePrivate) {
          params.delete('includePrivate');
        } else {
          params.set('includePrivate', '1');
        }
        return params;
      },
      { replace: true },
    );
  }, [includePrivate, setSearchParams]);

  const headerTitle = useMemo(() => {
    if (!owner) return t('studies.byUser.loading', 'Loading studies…');
    return isOwner
      ? t('studies.byUser.titleMine', 'My studies')
      : t('studies.byUser.title', '{{username}}’s studies', {
          username: owner.username,
        });
  }, [owner, isOwner, t]);

  if (!userId) {
    return (
      <div className="studies-page studies-by-user" data-testid="user-studies-page">
        <div className="studies-page__error" data-testid="user-studies-error">
          {t('studies.byUser.errorNoUser', 'No user specified.')}
        </div>
      </div>
    );
  }

  return (
    <div
      className="studies-page studies-by-user"
      data-testid="user-studies-page"
      data-user-id={userId}
      data-owner={isOwner ? 'true' : 'false'}
    >
      <header
        className="studies-by-user__header"
        data-testid="user-studies-header"
      >
        <div
          className="studies-by-user__avatar"
          aria-hidden="true"
          data-testid="user-studies-avatar"
        >
          {(owner?.username ?? '?').charAt(0).toUpperCase()}
        </div>
        <div className="studies-by-user__title-block">
          <h1
            className="studies-by-user__title"
            data-testid="user-studies-title"
          >
            {headerTitle}
          </h1>
          {owner && (
            <Link
              to={`/player/${encodeURIComponent(owner.username)}`}
              className="studies-by-user__profile-link"
              data-testid="user-studies-profile-link"
            >
              @{owner.username}
            </Link>
          )}
        </div>
        {isOwner && (
          <label
            className="studies-by-user__include-private"
            data-testid="user-studies-include-private"
          >
            <input
              type="checkbox"
              checked={includePrivate}
              onChange={togglePrivate}
              data-testid="user-studies-include-private-input"
            />
            <span>
              {t('studies.byUser.includePrivate', 'Show private & unlisted')}
            </span>
          </label>
        )}
      </header>

      {pageState === 'loading' && (
        <div
          className="studies-page__loading"
          data-testid="user-studies-loading"
        >
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {pageState === 'error' && (
        <div className="studies-page__error" data-testid="user-studies-error">
          {t('studies.error.load', 'Failed to load studies.')}
        </div>
      )}

      {pageState === 'empty' && (
        <div className="studies-page__empty" data-testid="user-studies-empty">
          <p>
            {isOwner
              ? t(
                  'studies.byUser.emptyMine',
                  'You haven’t created any studies yet.',
                )
              : t(
                  'studies.byUser.emptyOther',
                  'This user has no public studies.',
                )}
          </p>
        </div>
      )}

      {pageState === 'ready' && (
        <div
          className="studies-catalog__grid"
          data-testid="user-studies-grid"
        >
          {items.map((s) => (
            <StudyCatalogCard key={s.id} study={s} ownerUsername={owner?.username} />
          ))}
        </div>
      )}

      {pageState === 'ready' && hasMore && (
        <div
          ref={sentinelRef}
          data-testid="user-studies-load-more-sentinel"
          aria-hidden="true"
          style={{ height: 1 }}
        />
      )}
      {loadingMore && (
        <div
          className="studies-page__loading"
          data-testid="user-studies-loading-more"
        >
          {t('common.loadingMore', 'Loading more…')}
        </div>
      )}
    </div>
  );
}
