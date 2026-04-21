import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalysisListItem } from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api';

const PAGE_SIZE = 20;
const LS_SAVED_FILTERS_KEY = 'workshopSavedFilters';

type CategoryFilter = 'all' | 'game_review' | 'puzzle' | 'analysis';

type SavedFilter = {
  id: string;
  name: string;
  category: string | null;
  tags: string | null;
  search: string | null;
  sortOrder: string | null;
};

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
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Init from URL
  const urlCategory = (searchParams.get('category') as CategoryFilter) || 'all';
  const urlTags = searchParams.get('tags')?.split(',').filter(Boolean) || [];
  const urlSearch = searchParams.get('search') || '';

  const [allAnalyses, setAllAnalyses] = useState<AnalysisListItem[]>([]);
  const [searchResults, setSearchResults] = useState<AnalysisListItem[] | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
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
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [savingFilter, setSavingFilter] = useState(false);
  const [filterNameInput, setFilterNameInput] = useState('');

  // Sync state → URL
  const updateUrl = useCallback((cat: CategoryFilter, tags: string[], search: string) => {
    const params: Record<string, string> = {};
    if (cat !== 'all') params.category = cat;
    if (tags.length > 0) params.tags = tags.join(',');
    if (search) params.search = search;
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);

  const setCategoryFilter = (cat: CategoryFilter) => {
    setCategoryFilterState(cat);
    setVisibleCount(PAGE_SIZE);
    updateUrl(cat, selectedTags, searchQuery);
  };

  const setSearchQuery = (q: string) => {
    setSearchQueryState(q);
    setVisibleCount(PAGE_SIZE);
    updateUrl(categoryFilter, selectedTags, q);
  };

  const setSelectedTags = (updater: string[] | ((prev: string[]) => string[])) => {
    setSelectedTagsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      updateUrl(categoryFilter, next, searchQuery);
      return next;
    });
  };

  const handleSaveFilter = useCallback(async () => {
    const name = filterNameInput.trim();
    if (!name) return;
    setSavingFilter(false);
    setFilterNameInput('');
    try {
      const created = await api.post<SavedFilter>('/analyses/filters', {
        name,
        category: categoryFilter === 'all' ? '' : categoryFilter,
        tags: selectedTags.join(','),
        search: searchQuery,
      });
      setSavedFilters((prev) => [created, ...prev]);
    } catch { /* ignore */ }
  }, [filterNameInput, categoryFilter, selectedTags, searchQuery]);

  const handleApplyFilter = useCallback((filter: SavedFilter) => {
    const cat = (filter.category || 'all') as CategoryFilter;
    const tags = filter.tags ? filter.tags.split(',').filter(Boolean) : [];
    setCategoryFilterState(cat);
    setSelectedTagsState(tags);
    setSearchQueryState(filter.search || '');
    setVisibleCount(PAGE_SIZE);
    updateUrl(cat, tags, filter.search || '');
  }, [updateUrl]);

  const handleDeleteFilter = useCallback(async (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
    try { await api.delete(`/analyses/filters/${id}`); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError('');
    api.get<AnalysisListItem[]>('/analyses')
      .then((data) => setAllAnalyses(data))
      .catch(() => setError(t('common.loadError', 'Failed to load analyses')))
      .finally(() => setLoading(false));

    // Load saved filters from API + migrate localStorage
    api.get<SavedFilter[]>('/analyses/filters')
      .then(async (filters) => {
        setSavedFilters(filters);
        // Migrate from localStorage if any
        try {
          const raw = localStorage.getItem(LS_SAVED_FILTERS_KEY);
          if (raw) {
            const local: { name: string; category: string; tags: string[]; search: string }[] = JSON.parse(raw);
            if (local.length > 0) {
              const created = await Promise.all(
                local.map((f) =>
                  api.post<SavedFilter>('/analyses/filters', {
                    name: f.name,
                    category: f.category === 'all' ? '' : f.category,
                    tags: Array.isArray(f.tags) ? f.tags.join(',') : (f.tags || ''),
                    search: f.search || '',
                  }).catch(() => null),
                ),
              );
              const migrated = created.filter(Boolean) as SavedFilter[];
              if (migrated.length > 0) setSavedFilters((prev) => [...migrated, ...prev]);
              localStorage.removeItem(LS_SAVED_FILTERS_KEY);
            }
          }
        } catch { /* ignore migration errors */ }
      })
      .catch(() => {});
  }, [user, t]);

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
      api.get<AnalysisListItem[]>(`/analyses/search?q=${encodeURIComponent(searchQuery)}`)
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

  const visibleAnalyses = filteredAnalyses.slice(0, visibleCount);
  const hasMore = visibleCount < filteredAnalyses.length;

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          setLoadingMore(true);
          setVisibleCount((prev) => prev + PAGE_SIZE);
          setLoadingMore(false);
        }
      },
      { threshold: 0.1 },
    );

    const el = sentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [hasMore, loadingMore]);

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
    <section className="workshop-section-block">
      {/* Category tabs */}
      <div className="workshop-category-tabs">
        {(['all', 'game_review', 'puzzle', 'analysis'] as const).map((cat) => (
          <button
            key={cat}
            className={`workshop-category-tab${categoryFilter === cat ? ' active' : ''}`}
            onClick={() => { setCategoryFilter(cat); setVisibleCount(PAGE_SIZE); }}
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
          onChange={(e) => { setSearchQuery(e.target.value); setVisibleCount(PAGE_SIZE); }}
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

      {/* Save filter — visible when any filter is active */}
      {(selectedTags.length > 0 || searchQuery || categoryFilter !== 'all') && (
        <div className="workshop-save-filter-row">
          {savingFilter ? (
            <span className="workshop-save-filter-inline">
              <input
                type="text"
                className="workshop-save-filter-input"
                value={filterNameInput}
                onChange={(e) => setFilterNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveFilter();
                  if (e.key === 'Escape') { setSavingFilter(false); setFilterNameInput(''); }
                }}
                placeholder={t('workshop.myAnalyses.filterName', 'Filter name')}
                autoFocus
              />
              <button className="workshop-tag-clear" onClick={handleSaveFilter}>
                {t('common.save', 'Save')}
              </button>
              <button className="workshop-tag-clear" onClick={() => { setSavingFilter(false); setFilterNameInput(''); }}>
                {t('common.cancel', 'Cancel')}
              </button>
            </span>
          ) : (
            <button className="workshop-tag-clear" onClick={() => setSavingFilter(true)}>
              {t('workshop.myAnalyses.saveFilter', 'Save filter')}
            </button>
          )}
        </div>
      )}

      {/* Saved filters */}
      {savedFilters.length > 0 && (
        <div className="workshop-saved-filters">
          <span className="workshop-saved-filters__label">{t('workshop.myAnalyses.savedFilters', 'Saved:')}</span>
          {savedFilters.map((f) => (
            <span key={f.id} className="workshop-saved-filter-chip" onClick={() => handleApplyFilter(f)}>
              {f.name}
              <button onClick={(e) => { e.stopPropagation(); handleDeleteFilter(f.id); }}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="workshop-analyses-toolbar">
        <button className="workshop-analyses-new-btn" onClick={() => navigate('/analysis')}>
          + {t('workshop.myAnalyses.newAnalysis', 'New Analysis')}
        </button>
        <span className="workshop-analyses-toolbar__spacer" />
        {!selectMode ? (
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
        <p className="workshop-section-block__empty">{error}</p>
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
