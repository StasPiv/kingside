import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import {
  studiesApi,
  type StudyDto,
  type StudyCatalogResponse,
} from '../api/studiesApi';
import { CreateStudyDialog } from '../components/studies/CreateStudyDialog';
import { StudyCatalogCard } from '../components/studies/StudyCatalogCard';

/**
 * KS-2886 / ADR-060 §3.4 (FC1) — каталог Studies `/studies`.
 *
 * Lichess-style каталог:
 *  • Top-табы: Hot / New / Updated / Popular / Mine — `?sort=<sort>`,
 *    `mine`-таб виден только авторизованным.
 *  • Поиск (`?q=`, debounced 300ms).
 *  • Sidebar — chip-список топ-topics с фильтром (`?topic=`).
 *  • Infinite scroll — backend offset-pagination (`?page=N`),
 *    `hasMore` останавливает loader.
 *  • URL — единственный источник состояния; refresh страницы или
 *    глубокая ссылка восстанавливают фильтры/сортировку.
 *
 * Backend: `GET /api/studies/catalog`. До B7 был flat `?mine=1` /
 * `/public`; теперь оба canon'a замыкаются на catalog-endpoint
 * (см. ADR-060 §3.4 K1–K3).
 */

type Sort = 'hot' | 'new' | 'updated' | 'popular' | 'mine';

const SORT_VALUES: ReadonlySet<Sort> = new Set([
  'hot',
  'new',
  'updated',
  'popular',
  'mine',
]);

/**
 * Дефолтные топ-topics на случай, если backend ещё не отдаёт
 * `?facets=topics` (KS-2886 описание). После B7 расширения — заменим
 * на динамический список из ответа.
 */
const DEFAULT_TOPICS = [
  'openings',
  'endgames',
  'tactics',
  'middlegame',
  'strategy',
  'pawns',
  'rook-endings',
  'kingside-attack',
  'queens-gambit',
  'sicilian',
];

const SEARCH_DEBOUNCE_MS = 300;

function parseSort(raw: string | null): Sort {
  if (raw && SORT_VALUES.has(raw as Sort)) return raw as Sort;
  return 'hot';
}

export function StudiesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL → state (single-source-of-truth) ─────────────────────────
  const sort = parseSort(searchParams.get('sort'));
  const q = searchParams.get('q') ?? '';
  const topic = searchParams.get('topic') ?? '';

  // Local input — debounced sync с URL. Иначе каждый keystroke
  // триггерил бы fetch.
  const [searchInput, setSearchInput] = useState<string>(q);
  useEffect(() => {
    // Когда URL меняется извне (back/forward, deep link) — синхронизируем
    // input. Не пишем в URL обратно (это сделает onChange handler).
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    if (searchInput === q) return;
    const handle = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (searchInput) {
            params.set('q', searchInput);
          } else {
            params.delete('q');
          }
          // Любая смена поиска сбрасывает пагинацию.
          params.delete('page');
          return params;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput, q, setSearchParams]);

  // ── Fetch state ─────────────────────────────────────────────────
  const [items, setItems] = useState<StudyDto[]>([]);
  const [pageState, setPageState] = useState<
    'idle' | 'loading' | 'ready' | 'empty' | 'error'
  >('idle');
  const [page, setPage] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [createOpen, setCreateOpen] = useState<boolean>(false);

  // `mine`-таб для гостя недоступен — переключаем на hot.
  const effectiveSort: Sort =
    sort === 'mine' && !user ? 'hot' : sort;

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('studies.title', 'Studies')} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [t]);

  const buildQuery = useCallback(
    (pageNum: number) => {
      const mine = effectiveSort === 'mine';
      return {
        sort: mine ? undefined : effectiveSort,
        q: q || undefined,
        topic: topic || undefined,
        page: pageNum,
        mine,
      };
    },
    [effectiveSort, q, topic],
  );

  const fetchFirstPage = useCallback(async () => {
    setPageState('loading');
    setPage(0);
    try {
      const resp: StudyCatalogResponse = await studiesApi.getCatalog(
        buildQuery(0),
      );
      setItems(resp.items);
      setHasMore(resp.hasMore);
      setPageState(resp.items.length === 0 ? 'empty' : 'ready');
    } catch {
      setItems([]);
      setHasMore(false);
      setPageState('error');
    }
  }, [buildQuery]);

  // Перезагрузка при смене фильтров/сортировки/поиска/тематики.
  useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    try {
      const resp = await studiesApi.getCatalog(buildQuery(nextPage));
      setItems((prev) => [...prev, ...resp.items]);
      setHasMore(resp.hasMore);
      setPage(nextPage);
    } catch {
      // Молча — пользователь увидит конец списка.
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, page, buildQuery]);

  // IntersectionObserver на sentinel — подгружает следующую страницу,
  // когда sentinel попадает в viewport (rootMargin 600px).
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

  // ── URL writers ─────────────────────────────────────────────────
  const setSort = useCallback(
    (next: Sort) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('sort', next);
          params.delete('page');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setTopic = useCallback(
    (next: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next) {
            params.set('topic', next);
          } else {
            params.delete('topic');
          }
          params.delete('page');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const clearAllFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('topic');
        params.delete('q');
        params.delete('page');
        return params;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // ── Render helpers ──────────────────────────────────────────────
  // KS-2886 fallback: если backend не отдаёт топ-topics, считаем их
  // на клиенте из текущих items + fallback на DEFAULT_TOPICS. Это
  // не идеально (только topics, попавшие в первую страницу), но
  // соответствует FC1: «или захардкоди топ-10».
  const sidebarTopics = useMemo<string[]>(() => {
    const seen = new Map<string, number>();
    for (const s of items) {
      for (const t of s.topics) {
        seen.set(t, (seen.get(t) ?? 0) + 1);
      }
    }
    const sorted = Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
    if (sorted.length >= 5) return sorted.slice(0, 10);
    // Если в items <5 уникальных topics — дополняем дефолтным списком.
    const merged: string[] = [...sorted];
    for (const t of DEFAULT_TOPICS) {
      if (merged.length >= 10) break;
      if (!merged.includes(t)) merged.push(t);
    }
    return merged;
  }, [items]);

  const tabs: Array<{ id: Sort; label: string; testid: string }> = [
    {
      id: 'hot',
      label: t('studies.catalog.tabs.hot', 'Hot'),
      testid: 'studies-tab-hot',
    },
    {
      id: 'new',
      label: t('studies.catalog.tabs.new', 'New'),
      testid: 'studies-tab-new',
    },
    {
      id: 'updated',
      label: t('studies.catalog.tabs.updated', 'Updated'),
      testid: 'studies-tab-updated',
    },
    {
      id: 'popular',
      label: t('studies.catalog.tabs.popular', 'Popular'),
      testid: 'studies-tab-popular',
    },
  ];
  if (user) {
    tabs.push({
      id: 'mine',
      label: t('studies.catalog.tabs.mine', 'Mine'),
      testid: 'studies-tab-mine',
    });
  }

  return (
    <div className="studies-page studies-catalog" data-testid="studies-page">
      <header className="studies-page__header">
        <h1>{t('studies.title', 'Studies')}</h1>
        <p className="studies-page__subtitle">
          {t(
            'studies.subtitle',
            'Curate your analysis in shareable studies — your own and the community’s.',
          )}
        </p>
      </header>

      <div className="studies-catalog__layout">
        {/* ── Sidebar: topics filter ───────────────────────────── */}
        <aside
          className="studies-catalog__sidebar"
          data-testid="studies-sidebar"
        >
          <div className="studies-catalog__sidebar-group">
            <h2 className="studies-catalog__sidebar-title">
              {t('studies.catalog.topics', 'Topics')}
            </h2>
            <div
              className="studies-catalog__topic-chips"
              data-testid="studies-topic-chips"
              role="list"
            >
              {sidebarTopics.map((tp) => {
                const active = topic === tp;
                return (
                  <button
                    key={tp}
                    type="button"
                    role="listitem"
                    className={`studies-catalog__topic-chip${active ? ' studies-catalog__topic-chip--active' : ''}`}
                    data-testid={`studies-topic-chip-${tp}`}
                    aria-pressed={active}
                    onClick={() => setTopic(active ? null : tp)}
                  >
                    {tp}
                  </button>
                );
              })}
            </div>
            {(topic || q) && (
              <button
                type="button"
                className="studies-catalog__sidebar-clear"
                data-testid="studies-clear-filters"
                onClick={clearAllFilters}
              >
                {t('studies.catalog.clearFilters', 'Clear filters')}
              </button>
            )}
          </div>
        </aside>

        {/* ── Main column ──────────────────────────────────────── */}
        <main
          className="studies-catalog__main"
          data-testid="studies-main"
        >
          <div
            className="studies-page__toolbar"
            data-testid="studies-toolbar"
          >
            <div
              className="studies-catalog__tabs"
              role="tablist"
              data-testid="studies-tabs"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={effectiveSort === tab.id}
                  className={`studies-page__tab${effectiveSort === tab.id ? ' studies-page__tab--active' : ''}`}
                  data-testid={tab.testid}
                  onClick={() => setSort(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {user && effectiveSort === 'mine' && (
              <button
                type="button"
                className="study-page__action studies-page__create-btn"
                data-testid="studies-create-btn"
                onClick={() => setCreateOpen(true)}
              >
                {t('studies.create.cta', '+ Create study')}
              </button>
            )}
          </div>

          <div
            className="studies-catalog__search"
            data-testid="studies-search"
          >
            <input
              className="studies-catalog__search-input"
              type="search"
              data-testid="studies-search-input"
              placeholder={t(
                'studies.catalog.searchPlaceholder',
                'Search studies…',
              )}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label={t('studies.catalog.searchAria', 'Search studies')}
            />
            {searchInput && (
              <button
                type="button"
                className="studies-catalog__search-clear"
                data-testid="studies-search-clear"
                onClick={() => setSearchInput('')}
                aria-label={t('studies.catalog.searchClear', 'Clear search')}
              >
                ×
              </button>
            )}
          </div>

          {pageState === 'loading' && (
            <div
              className="studies-page__loading"
              data-testid="studies-loading"
            >
              {t('common.loading', 'Loading…')}
            </div>
          )}

          {pageState === 'error' && (
            <div className="studies-page__error" data-testid="studies-error">
              {t('studies.error.load', 'Failed to load studies.')}
            </div>
          )}

          {pageState === 'empty' && (
            <div className="studies-page__empty" data-testid="studies-empty">
              <p>
                {effectiveSort === 'mine'
                  ? t(
                      'studies.empty.mine',
                      'You don’t have any studies yet. Create your first one to get started.',
                    )
                  : t(
                      'studies.empty.catalog',
                      'No studies match your filters. Try clearing them or browse another tab.',
                    )}
              </p>
              {user && effectiveSort === 'mine' && (
                <button
                  type="button"
                  className="study-page__action studies-page__empty-cta"
                  data-testid="studies-empty-create-btn"
                  onClick={() => setCreateOpen(true)}
                >
                  {t('studies.create.cta', '+ Create study')}
                </button>
              )}
            </div>
          )}

          {pageState === 'ready' && (
            <div
              className="studies-catalog__grid"
              data-testid="studies-grid"
            >
              {items.map((s) => (
                <StudyCatalogCard key={s.id} study={s} />
              ))}
            </div>
          )}

          {/* Sentinel для infinite scroll. Видимый только при наличии
              следующей страницы — IntersectionObserver не мониторит
              элемент, если его нет. */}
          {pageState === 'ready' && hasMore && (
            <div
              ref={sentinelRef}
              data-testid="studies-load-more-sentinel"
              aria-hidden="true"
              style={{ height: 1 }}
            />
          )}
          {loadingMore && (
            <div
              className="studies-page__loading"
              data-testid="studies-loading-more"
            >
              {t('common.loadingMore', 'Loading more…')}
            </div>
          )}
        </main>
      </div>

      {createOpen && (
        <CreateStudyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(study) => {
            navigate(`/studies/${encodeURIComponent(study.slug)}`);
          }}
        />
      )}
    </div>
  );
}
