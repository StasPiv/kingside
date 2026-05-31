import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  AnalysisListItem,
  SavedFilterDto,
  SavedFilterParams,
} from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api';
import { openAnalysis } from '../../utils/openAnalysis';
import { SavedFiltersDropdown } from '../savedFilters/SavedFiltersDropdown';

// KS-2948: backend дефолтный limit=20, max 100. KS-2950: фронт грузит
// 100 за раз и инфинит-скроллом дозагружает следующие страницы.
const SERVER_PAGE_SIZE = 100;

type CategoryFilter = 'all' | 'game_review' | 'puzzle' | 'analysis';

/**
 * KS-3504 (ADR-092 F2): location.state, который активирует
 * selection-режим. Пишется caller'ом (GuessLandingPage по клику
 * «📂 Pick from workshop»). При его наличии — sticky-баннер сверху,
 * кнопка «✓ Pick» на каждой карточке и **скрытые batch-actions**
 * (по дефолту архитектора: в режиме выбора Export/Delete не показываем).
 */
interface WorkshopSelectionState {
  returnTo?: string;
  returnLabel?: string;
}

/** Узкий тип saved-filter params для workshop-секции — используется в
 *  generic'е dropdown'а, чтобы получить точные сигнатуры onApply/create. */
type WorkshopSavedFilterParams = Extract<
  SavedFilterParams,
  { section: 'workshop' }
>;

function AnalysisItemTitle({ analysis, categoryIcon }: { analysis: AnalysisListItem; categoryIcon: string }) {
  return (
    <span className="workshop-analysis-item__title">
      <span className="workshop-analysis-item__cat-icon">{categoryIcon}</span>
      {analysis.headline || analysis.title}
    </span>
  );
}

export function WorkshopAnalysisList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // KS-3504 + KS-3501-style hotfix: запоминаем selection-state на mount
  // через useState(lazy-init). updateUrl ниже (replace, без передачи
  // state) при любом изменении фильтра стирал history.state — фикс
  // тот же, что в ArchiveGamesPage. Селекшн уходит только при
  // cancel/выборе (оба уводят с /workshop).
  const [selectionState] = useState<WorkshopSelectionState | null>(
    () => (location.state as WorkshopSelectionState | null) ?? null,
  );
  const selectionReturnTo = selectionState?.returnTo ?? null;
  const selectionReturnLabel = selectionState?.returnLabel ?? '';
  const isSelectionMode = !!selectionReturnTo;

  // Init from URL
  const urlCategory = (searchParams.get('category') as CategoryFilter) || 'all';
  const urlTags = searchParams.get('tags')?.split(',').filter(Boolean) || [];
  const urlSearch = searchParams.get('search') || '';

  const [allAnalyses, setAllAnalyses] = useState<AnalysisListItem[]>([]);
  const [searchResults, setSearchResults] = useState<AnalysisListItem[] | null>(null);
  // KS-2950: серверная пагинация. `serverHasMore` — есть ли ещё страницы
  // на сервере (true пока последний запрос вернул ровно SERVER_PAGE_SIZE).
  const [serverHasMore, setServerHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  // KS-2034: используется только setter (для поиска через timeout) — флаг
  // `searching` по факту не читается в JSX. Префикс `_` помечает
  // намеренно неиспользуемый элемент destructure.
  const [, setSearching] = useState(false);
  const [error, setError] = useState('');
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [categoryFilter, setCategoryFilterState] = useState<CategoryFilter>(urlCategory);
  const [searchQuery, setSearchQueryState] = useState(urlSearch);
  const [selectedTags, setSelectedTagsState] = useState<string[]>(urlTags);
  const [addingTagId, setAddingTagId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  // KS-2942: id применённого пресета из URL (hint для modified-индикации).
  const savedFilterIdFromUrl = searchParams.get('savedFilter');

  // Sync state → URL.
  // KS-2942: 4-й аргумент `savedFilterId` пробрасывается из URL, чтобы
  // `?savedFilter=<id>` не терялся при ручном изменении любого поля
  // (иначе исчезла бы кнопка «Reset to saved»). При apply из dropdown'а
  // передаётся новый id; при handleResetFilters / apply без presetId —
  // `undefined`, и параметр не пишется в URL.
  const updateUrl = useCallback(
    (
      cat: CategoryFilter,
      tags: string[],
      search: string,
      savedFilterId: string | null | undefined,
    ) => {
      const params: Record<string, string> = {};
      if (cat !== 'all') params.category = cat;
      if (tags.length > 0) params.tags = tags.join(',');
      if (search) params.search = search;
      if (savedFilterId) params.savedFilter = savedFilterId;
      // KS-3504: пробрасываем current history.state в replace, чтобы
      // selection-режим (returnTo/returnLabel) не стёрся при любой
      // правке URL (см. KS-3501 для архива — тот же класс бага).
      setSearchParams(params, { replace: true, state: location.state });
    },
    [setSearchParams, location.state],
  );

  // KS-3504 (ADR-092 F2): селект анализа в selection-режиме →
  // GET /analyses/:id → navigate(returnTo, {state: unified shape}).
  // Ошибка GET — console.warn, остаёмся на странице.
  const handleSelectAnalysis = useCallback(
    (a: AnalysisListItem) => {
      if (!selectionReturnTo) return;
      type AnalysisDetail = AnalysisListItem & { pgn?: string };
      api
        .get<AnalysisDetail>(`/analyses/${a.id}`)
        .then((full) => {
          navigate(selectionReturnTo, {
            state: {
              source: 'own',
              refId: a.id,
              pgn: full.pgn ?? '',
              title: a.headline || a.title || '',
            },
          });
        })
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.warn('[workshop-selection] GET /analyses failed', e);
        });
    },
    [navigate, selectionReturnTo],
  );

  const handleCancelSelection = useCallback(() => {
    if (!selectionReturnTo) return;
    navigate(selectionReturnTo);
  }, [navigate, selectionReturnTo]);

  const setCategoryFilter = (cat: CategoryFilter) => {
    setCategoryFilterState(cat);
    updateUrl(cat, selectedTags, searchQuery, savedFilterIdFromUrl);
  };

  const setSearchQuery = (q: string) => {
    setSearchQueryState(q);
    updateUrl(categoryFilter, selectedTags, q, savedFilterIdFromUrl);
  };

  const setSelectedTags = (updater: string[] | ((prev: string[]) => string[])) => {
    setSelectedTagsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      updateUrl(categoryFilter, next, searchQuery, savedFilterIdFromUrl);
      return next;
    });
  };

  /**
   * KS-2933 (B3): снапшот текущих фильтров для SavedFiltersDropdown.
   * `category === 'all'` маппится в `null` (фильтр-«любая категория»);
   * пустой `searchQuery` — также `null`. `sortOrder` пока не используется
   * в Мастерской (нет UI-управления порядком) — сохраняем `null`, чтобы
   * не терять контракт.
   */
  const currentParams = useMemo<WorkshopSavedFilterParams>(
    () => ({
      section: 'workshop',
      category: categoryFilter === 'all' ? null : categoryFilter,
      tags: selectedTags,
      search: searchQuery ? searchQuery : null,
      sortOrder: null,
    }),
    [categoryFilter, selectedTags, searchQuery],
  );

  /**
   * KS-2933 (B3) + KS-2942: применить сохранённый пресет. Восстанавливаем
   * локальный стейт и пишем в URL (`category`/`tags`/`search` +
   * `savedFilter=<presetId>` как hint для modified-индикации).
   *
   * `category === null` → 'all' для UI; неизвестные категории
   * (на случай legacy-записей) приводим к 'all'.
   */
  const handleApplyFilter = useCallback(
    (params: WorkshopSavedFilterParams, presetId?: string) => {
      const allowedCategories: ReadonlyArray<CategoryFilter> = [
        'all',
        'game_review',
        'puzzle',
        'analysis',
      ];
      const cat: CategoryFilter =
        params.category &&
        allowedCategories.includes(params.category as CategoryFilter)
          ? (params.category as CategoryFilter)
          : 'all';
      const tags = params.tags ?? [];
      const search = params.search ?? '';
      setCategoryFilterState(cat);
      setSelectedTagsState(tags);
      setSearchQueryState(search);
      updateUrl(cat, tags, search, presetId ?? null);
    },
    [updateUrl],
  );

  /**
   * KS-2942: список известных saved-filters (зеркало dropdown'а через
   * `onFiltersChange`). Используется для подсчёта `activeFilter`.
   */
  const [knownSavedFilters, setKnownSavedFilters] = useState<
    SavedFilterDto[]
  >([]);

  /**
   * KS-2942: workshop-аналог `findMatchingFilter`. Нормализация:
   * `category` пустой → null, `tags` сортируется, пустые строки → null,
   * `sortOrder='' / 'newest' (default)` рассматривается как `null`
   * (текущая UI-форма не управляет sortOrder, поэтому строгое
   * совпадение по нему было бы хрупким).
   */
  const findWorkshopMatchingFilter = useCallback(
    (
      cur: WorkshopSavedFilterParams,
      list: SavedFilterDto[],
    ): string | null => {
      if (!Array.isArray(list)) return null;
      const canon = (p: WorkshopSavedFilterParams) => ({
        section: 'workshop' as const,
        category: p.category && p.category.length > 0 ? p.category : null,
        tags: [...p.tags]
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .sort(),
        search: p.search && p.search.length > 0 ? p.search : null,
      });
      const ref = JSON.stringify(canon(cur));
      for (const f of list) {
        if (f.section !== 'workshop') continue;
        const cand = canon(f.params as WorkshopSavedFilterParams);
        if (JSON.stringify(cand) === ref) return f.id;
      }
      return null;
    },
    [],
  );

  /**
   * KS-2942: 3-state индикация активного пресета (см. ArchiveGamesPage).
   */
  const activeFilter = useMemo(() => {
    const matchedId = findWorkshopMatchingFilter(
      currentParams as WorkshopSavedFilterParams,
      knownSavedFilters,
    );
    if (matchedId) return { id: matchedId, state: 'active' as const };
    if (
      savedFilterIdFromUrl &&
      knownSavedFilters.some((f) => f.id === savedFilterIdFromUrl)
    ) {
      return { id: savedFilterIdFromUrl, state: 'modified' as const };
    }
    return null;
  }, [
    currentParams,
    knownSavedFilters,
    savedFilterIdFromUrl,
    findWorkshopMatchingFilter,
  ]);

  // KS-3259: счётчик retry-попыток для useEffect ниже. setRetryNonce(n+1)
  // — кнопка «Повторить» в error-state.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError('');
    // KS-2948/KS-2950: backend дефолт limit=20, max 100. Тянем 100 разом;
    // если страница «полная» — выставляем флаг hasMore и догружаем
    // следующие страницы по infinite-scroll.
    api
      .get<AnalysisListItem[]>(`/analyses?limit=${SERVER_PAGE_SIZE}&offset=0`)
      .then((data) => {
        setAllAnalyses(data);
        setServerHasMore(data.length === SERVER_PAGE_SIZE);
      })
      // KS-3259: локализованное сообщение об ошибке. До этого тикета
      // English fallback показывался поверх русского UI — плохой UX.
      .catch(() =>
        setError(
          t('workshop.myAnalyses.loadError', 'Failed to load analyses'),
        ),
      )
      .finally(() => setLoading(false));
    // KS-2933 (B3): загрузка saved-filters и миграция legacy
    // `localStorage['workshopSavedFilters']` теперь — забота
    // `useSavedFilters('workshop')` внутри SavedFiltersDropdown.
  }, [user, t, retryNonce]);

  /**
   * KS-2950: догрузить следующую серверную страницу анализов. Используется
   * IntersectionObserver'ом на sentinel'е. Идемпотентность через
   * `loadingMore`-флаг и проверку `serverHasMore`.
   */
  const loadMoreFromServer = useCallback(async () => {
    if (loadingMore || !serverHasMore) return;
    setLoadingMore(true);
    try {
      const offset = allAnalyses.length;
      const next = await api.get<AnalysisListItem[]>(
        `/analyses?limit=${SERVER_PAGE_SIZE}&offset=${offset}`,
      );
      setAllAnalyses((prev) => [...prev, ...next]);
      setServerHasMore(next.length === SERVER_PAGE_SIZE);
    } catch {
      // Молча оставляем загруженное. Кнопка/sentinel останутся видимы —
      // следующий заход в зону видимости попробует ещё раз.
    } finally {
      setLoadingMore(false);
    }
  }, [allAnalyses.length, loadingMore, serverHasMore]);

  // Debounced API search when query >= 2 chars
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(() => {
      // KS-2950: search endpoint тоже подразумевает лимит, явно
      // передаём верхнюю границу (max 100 на бэке).
      api
        .get<AnalysisListItem[]>(
          `/analyses/search?q=${encodeURIComponent(searchQuery)}&limit=${SERVER_PAGE_SIZE}`,
        )
        .then((data) => setSearchResults(data))
        .catch(() => setSearchResults(null))
        .finally(() => setSearching(false));
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery]);

  // All unique tags for autocomplete
  const allTags = Array.from(new Set(allAnalyses.flatMap((a) => a.tags ?? [])));

  // Use API results when searching, otherwise local filter
  const baseAnalyses = searchResults !== null ? searchResults : allAnalyses;

  const filteredAnalyses = baseAnalyses.filter((a) => {
    const cat = a.category ?? 'analysis';
    if (categoryFilter === 'all' && cat === 'puzzle') return false;
    if (categoryFilter !== 'all' && cat !== categoryFilter) return false;
    // Tag filter (AND)
    if (selectedTags.length > 0) {
      const aTags = a.tags ?? [];
      if (!selectedTags.every((tag) => aTags.includes(tag))) return false;
    }
    return true;
  });

  // KS-2950: серверная пагинация — рендерим всё, что подтянули.
  // Локальные фильтры (category/tags) применяются к загруженной странице.
  // При поиске (searchResults!==null) серверный loadMore отключён — поиск
  // отдельный endpoint и сам ограничен SERVER_PAGE_SIZE.
  const visibleAnalyses = filteredAnalyses;
  const hasMore = searchResults === null && serverHasMore;

  // Infinite scroll: при пересечении sentinel'а догружаем следующую
  // серверную страницу (а не двигаем визуальный курсор как раньше).
  useEffect(() => {
    if (!hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          void loadMoreFromServer();
        }
      },
      { threshold: 0.1 },
    );

    const el = sentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [hasMore, loadingMore, loadMoreFromServer]);

  const handleOpen = (analysis: AnalysisListItem) => {
    navigate('/analysis/' + analysis.id, {
      state: {
        breadcrumbRootTitle: t('workshop.myAnalyses.title'),
        breadcrumbRootUrl: '/workshop',
      },
    });
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    api.delete(`/analyses/${id}`)
      .then(() => setAllAnalyses((prev) => prev.filter((a) => a.id !== id)))
      .catch(() => {});
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === allAnalyses.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allAnalyses.map((a) => a.id)));
    }
  };

  const handleExport = async () => {
    if (selected.size === 0) return;
    setExporting(true);
    try {
      const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/analyses/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const pgn = await res.text();
      const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `analyses-${new Date().toISOString().slice(0, 10)}.pgn`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err) {
      console.error('[Export PGN] Failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleBatchDelete = async () => {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!window.confirm(t('workshop.myAnalyses.confirmDelete', `Delete ${count} analysis(es)?`))) return;
    setDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => api.delete(`/analyses/${id}`).catch(() => {})));
      setAllAnalyses((prev) => prev.filter((a) => !selected.has(a.id)));
      setSelected(new Set());
    } catch (err) {
      console.error('[Delete analyses] Failed:', err);
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const CATEGORY_ICON: Record<string, string> = {
    game_review: '♟',
    puzzle: '🧩',
    analysis: '🔍',
  };

  return (
    <section
      className={`workshop-section-block${
        isSelectionMode ? ' workshop-section-block--selection' : ''
      }`}
      data-selection={isSelectionMode ? 'true' : 'false'}
    >
      {/* KS-3504 (ADR-092 F2): sticky-баннер selection-режима. CSS
          стилизация — за layout L1-ext (KS-3505). */}
      {isSelectionMode && (
        <div
          className="workshop-section-block__selection-banner"
          data-testid="workshop-selection-banner"
          role="region"
          aria-label={t('workshop.selection.title', {
            defaultValue: 'Pick an analysis for {{label}}',
            label: selectionReturnLabel,
          })}
        >
          <span
            className="workshop-section-block__selection-text"
            data-testid="workshop-selection-text"
          >
            {t('workshop.selection.title', {
              defaultValue: 'Pick an analysis for {{label}}',
              label: selectionReturnLabel,
            })}
          </span>
          <button
            type="button"
            className="workshop-section-block__selection-cancel"
            data-testid="workshop-selection-cancel"
            onClick={handleCancelSelection}
          >
            {t('workshop.selection.cancel', { defaultValue: '✕ Cancel' })}
          </button>
        </div>
      )}

      {/* Category tabs */}
      <div className="workshop-category-tabs">
        {(['all', 'game_review', 'puzzle', 'analysis'] as const).map((cat) => (
          <button
            key={cat}
            className={`workshop-category-tab${categoryFilter === cat ? ' active' : ''}`}
            onClick={() => setCategoryFilter(cat)}
          >
            {t(`workshop.categories.${cat}`, cat === 'all' ? 'All' : cat === 'game_review' ? 'Games' : cat === 'puzzle' ? 'Puzzles' : 'Free')}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="workshop-search">
        <input
          type="text"
          placeholder={t('workshop.myAnalyses.searchPlaceholder', 'Search by player, event, opening...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Tag filter chips */}
      {selectedTags.length > 0 && (
        <div className="workshop-tag-filters">
          {selectedTags.map((tag) => (
            <span key={tag} className="workshop-tag-chip workshop-tag-chip--active">
              {tag}
              <button onClick={() => setSelectedTags((prev: string[]) => prev.filter((t2: string) => t2 !== tag))}>×</button>
            </span>
          ))}
          <button className="workshop-tag-clear" onClick={() => setSelectedTags([])}>
            {t('workshop.myAnalyses.clearTags', 'Clear')}
          </button>
        </div>
      )}

      {/*
        KS-2933 (B3): старая inline-«Save filter» строка и блок чипов
        `.workshop-saved-filters` заменены на общий SavedFiltersDropdown
        (B2). Хранение, лимит, дубль-чек, миграция legacy LS — внутри
        `useSavedFilters('workshop')` (B1). Удаление старого CSS
        `.workshop-saved-filters` / `.workshop-save-filter-row` —
        координируется с @layout в KS-2934.
      */}
      {user && (
        <div className="workshop-saved-filters-row">
          <SavedFiltersDropdown<WorkshopSavedFilterParams>
            section="workshop"
            currentParams={currentParams}
            onApply={handleApplyFilter}
            activeFilter={activeFilter}
            onFiltersChange={setKnownSavedFilters}
            isGuest={!user}
          />
        </div>
      )}

      {/* KS-3504: batch-actions (Select/Export/Delete) скрыты в
          selection-режиме по дефолту архитектора — пользователь
          выбирает конкретный анализ, batch-операции не нужны. New —
          сохраняем (создание чистого анализа всё ещё уместно). */}
      <div className="workshop-analyses-toolbar">
        <button
          className="workshop-analyses-new-btn"
          onClick={() => {
            // KS-2604 (ADR-051 §4 B2): создаём пустой анализ через
            // helper из B1 — он сделает POST /analyses {pgn:''} и
            // navigate(/analysis/<id>) с уникальным id. До этого
            // тикета здесь был navigate('/analysis') без id, и из-за
            // ad-hoc autosave AnalysisPage'а на mount открывалась
            // прошлая партия (KS-2403 / симптом «прошлая партия в
            // Мастерской»). C-этап удалит ad-hoc autosave полностью;
            // здесь же достаточно того, что новая запись получает
            // уникальный id и пользователь начинает с чистой доски.
            void openAnalysis(navigate, {
              pgn: '',
              title: t('workshop.myAnalyses.newAnalysis', 'New Analysis'),
              t,
            });
          }}
        >
          + {t('workshop.myAnalyses.newAnalysis', 'New Analysis')}
        </button>
        <span className="workshop-analyses-toolbar__spacer" />
        {isSelectionMode ? null : !selectMode ? (
          allAnalyses.length > 0 && (
            <button className="workshop-analyses-select-btn" onClick={() => setSelectMode(true)}>
              {t('workshop.myAnalyses.select', 'Select')}
            </button>
          )
        ) : (
              <>
                <label className="workshop-analyses-select-all">
                  <input
                    type="checkbox"
                    checked={selected.size === allAnalyses.length && allAnalyses.length > 0}
                    onChange={toggleSelectAll}
                  />
                  {t('workshop.myAnalyses.selectAll', 'Select All')}
                </label>
                {selected.size > 0 && (
                  <>
                  <button className="workshop-analyses-export-btn" onClick={handleExport} disabled={exporting}>
                    {exporting
                      ? t('common.loading')
                      : t('workshop.myAnalyses.exportPgn', `Export PGN (${selected.size})`)}
                  </button>
                  <button className="workshop-analyses-delete-btn" onClick={handleBatchDelete} disabled={deleting}>
                    {deleting
                      ? t('common.loading')
                      : t('workshop.myAnalyses.deleteSelected', `Delete (${selected.size})`)}
                  </button>
                  </>
                )}
                <button className="workshop-analyses-cancel-btn" onClick={() => { setSelectMode(false); setSelected(new Set()); }}>
                  {t('common.cancel', 'Cancel')}
                </button>
              </>
            )}
      </div>
      {!user ? (
        <p className="workshop-section-block__empty">
          {t('workshop.myAnalyses.loginRequired', 'Sign in to save your analyses')}
        </p>
      ) : loading ? (
        <p className="workshop-section-block__empty">{t('common.loading')}</p>
      ) : error ? (
        // KS-3259: добавлена кнопка «Повторить» (раньше был просто
        // текст ошибки — пользователю приходилось руками reload'ить
        // страницу).
        <div
          className="workshop-section-block__empty"
          data-testid="workshop-analyses-error"
          role="alert"
        >
          <p style={{ margin: 0 }}>{error}</p>
          <button
            type="button"
            className="workshop-analyses-retry"
            data-testid="workshop-analyses-retry"
            onClick={() => setRetryNonce((n) => n + 1)}
            style={{ marginTop: 8 }}
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      ) : allAnalyses.length === 0 ? (
        <p className="workshop-section-block__empty">{t('workshop.myAnalyses.empty')}</p>
      ) : (
        <>
          <div className="workshop-analyses-list">
            {visibleAnalyses.map((analysis) => (
              <div
                key={analysis.id}
                className={`workshop-analysis-item${selectMode && selected.has(analysis.id) ? ' workshop-analysis-item--selected' : ''}`}
                onClick={() => { if (selectMode) { toggleSelect(analysis.id, { stopPropagation: () => {} } as React.MouseEvent); } else { handleOpen(analysis); } }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleOpen(analysis)}
              >
                {selectMode && (
                  <input
                    type="checkbox"
                    className="workshop-analysis-item__checkbox"
                    checked={selected.has(analysis.id)}
                    onClick={(e) => toggleSelect(analysis.id, e)}
                    onChange={() => {}}
                  />
                )}
                <div className="workshop-analysis-item__main">
                  <AnalysisItemTitle analysis={analysis} categoryIcon={CATEGORY_ICON[analysis.category ?? 'analysis'] ?? '🔍'} />
                  <div className="workshop-analysis-item__meta">
                    <span className="workshop-analysis-item__date">{formatDate(analysis.createdAt)}</span>
                    {analysis.opening && (
                      <span className="workshop-analysis-item__opening">{analysis.opening}</span>
                    )}
                  </div>
                  {/* Tags */}
                  <div className="workshop-analysis-item__tags">
                    {(analysis.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="workshop-tag-chip"
                        onClick={(e) => { e.stopPropagation(); if (!selectedTags.includes(tag)) setSelectedTags((prev) => [...prev, tag]); }}
                      >
                        {tag}
                        <button onClick={(e) => {
                          e.stopPropagation();
                          const newTags = (analysis.tags ?? []).filter((t2) => t2 !== tag);
                          api.patch(`/analyses/${analysis.id}`, { tags: newTags }).then(() => {
                            setAllAnalyses((prev) => prev.map((a) => a.id === analysis.id ? { ...a, tags: newTags } : a));
                          }).catch(() => {});
                        }}>×</button>
                      </span>
                    ))}
                    {addingTagId === analysis.id ? (
                      <span className="workshop-tag-input-wrap">
                        <input
                          type="text"
                          className="workshop-tag-input"
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && tagInput.trim()) {
                              e.stopPropagation();
                              const newTag = tagInput.trim().toLowerCase();
                              const newTags = [...new Set([...(analysis.tags ?? []), newTag])];
                              api.patch(`/analyses/${analysis.id}`, { tags: newTags }).then(() => {
                                setAllAnalyses((prev) => prev.map((a) => a.id === analysis.id ? { ...a, tags: newTags } : a));
                              }).catch(() => {});
                              setTagInput('');
                              setAddingTagId(null);
                            }
                            if (e.key === 'Escape') { setAddingTagId(null); setTagInput(''); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          list={`tags-${analysis.id}`}
                          placeholder={t('workshop.myAnalyses.tagPlaceholder', 'tag...')}
                        />
                        <datalist id={`tags-${analysis.id}`}>
                          {allTags.filter((tag) => !(analysis.tags ?? []).includes(tag)).map((tag) => (
                            <option key={tag} value={tag} />
                          ))}
                        </datalist>
                      </span>
                    ) : (
                      <button className="workshop-tag-add" onClick={(e) => { e.stopPropagation(); setAddingTagId(analysis.id); setTagInput(''); }}>+</button>
                    )}
                  </div>
                </div>
                {/* KS-3504: в selection-режиме явная кнопка «✓ Pick»
                    рядом с delete. stopPropagation предотвращает
                    срабатывание row-onClick'а (он делает handleOpen
                    или toggleSelect). Сам row продолжает вести в
                    /analysis как обычно — выбор только через кнопку. */}
                {isSelectionMode && (
                  <button
                    type="button"
                    className="workshop-analysis-item__pick"
                    data-testid={`workshop-analysis-item-pick-${analysis.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectAnalysis(analysis);
                    }}
                    aria-label={t('workshop.selection.pickAria', {
                      defaultValue: 'Pick this analysis',
                    })}
                  >
                    {t('workshop.selection.pick', { defaultValue: '✓ Pick' })}
                  </button>
                )}
                <button
                  className="workshop-analysis-item__delete"
                  onClick={(e) => handleDelete(e, analysis.id)}
                  title={t('workshop.myAnalyses.delete')}
                  aria-label={t('workshop.myAnalyses.delete')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {hasMore && (
            <div ref={sentinelRef} className="games-load-more">
              {loadingMore && <span>{t('common.loading')}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
