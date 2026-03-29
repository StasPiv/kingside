import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalysisListItem } from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api';

const PAGE_SIZE = 20;

export function WorkshopAnalysisList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [allAnalyses, setAllAnalyses] = useState<AnalysisListItem[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'game_review' | 'puzzle' | 'analysis'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [addingTagId, setAddingTagId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError('');
    api.get<AnalysisListItem[]>('/api/analyses')
      .then((data) => setAllAnalyses(data))
      .catch(() => setError(t('common.loadError', 'Failed to load analyses')))
      .finally(() => setLoading(false));
  }, [user, t]);

  // All unique tags for autocomplete
  const allTags = Array.from(new Set(allAnalyses.flatMap((a) => a.tags ?? [])));

  const filteredAnalyses = allAnalyses.filter((a) => {
    const cat = a.category ?? 'analysis';
    if (categoryFilter === 'all' && cat === 'puzzle') return false;
    if (categoryFilter !== 'all' && cat !== categoryFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!(a.title?.toLowerCase().includes(q) || a.opening?.toLowerCase().includes(q))) return false;
    }
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
    api.delete(`/api/analyses/${id}`)
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
      const res = await fetch(`${API_URL}/api/analyses/export`, {
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
      await Promise.all(Array.from(selected).map((id) => api.delete(`/api/analyses/${id}`).catch(() => {})));
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
          placeholder={t('workshop.myAnalyses.searchPlaceholder', 'Search by title...')}
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
              <button onClick={() => setSelectedTags((prev) => prev.filter((t2) => t2 !== tag))}>×</button>
            </span>
          ))}
          <button className="workshop-tag-clear" onClick={() => setSelectedTags([])}>
            {t('workshop.myAnalyses.clearTags', 'Clear')}
          </button>
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
                  <span className="workshop-analysis-item__title">
                    <span className="workshop-analysis-item__cat-icon">{CATEGORY_ICON[analysis.category ?? 'analysis'] ?? '🔍'}</span>
                    {analysis.title}
                  </span>
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
                          api.patch(`/api/analyses/${analysis.id}`, { tags: newTags }).then(() => {
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
                              api.patch(`/api/analyses/${analysis.id}`, { tags: newTags }).then(() => {
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
