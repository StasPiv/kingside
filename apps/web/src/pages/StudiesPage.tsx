import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import { studiesApi, type StudyDto } from '../api/studiesApi';
import { CreateStudyDialog } from '../components/studies/CreateStudyDialog';

/**
 * KS-2825 (KS-2815 §B.5, §A.5) — каталог Studies `/studies`.
 *
 * Композиция по образцу `DiscoverCoursesPage`. Два таба:
 *  - **Мои** — `GET /api/studies?mine=1` (требует JWT; гостям таб не
 *    рендерится — для них автоматически активен «Публичные»).
 *  - **Публичные** — `GET /api/studies/public` (без auth).
 *
 * Tab-state в `?tab=mine|public` query — для глубоких ссылок.
 *
 * Создание студии — отдельная модалка/маршрут (KS-2826 — туда же
 * добавим UI «Создать»; сейчас в каталоге кнопка не показывается до
 * следующего тикета).
 */

type Tab = 'mine' | 'public';

export function StudiesPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryTab = (searchParams.get('tab') as Tab | null) ?? null;
  // KS-2852: модалка создания студии.
  const [createOpen, setCreateOpen] = useState<boolean>(false);

  // Гость не имеет таба «Мои» — для него всегда «Публичные».
  const activeTab: Tab = useMemo(() => {
    if (!user) return 'public';
    if (queryTab === 'mine' || queryTab === 'public') return queryTab;
    return 'mine';
  }, [user, queryTab]);

  const [studies, setStudies] = useState<StudyDto[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('studies.title', 'Studies')} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [t]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp =
        activeTab === 'mine'
          ? await studiesApi.list({ mine: true })
          : await studiesApi.listPublic();
      setStudies(resp.data);
    } catch {
      setError(t('studies.error.load', 'Failed to load studies.'));
      setStudies([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setTab = (next: Tab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('tab', next);
        return params;
      },
      { replace: true },
    );
  };

  // Локализованное «дата обновления» — без отдельной либы, простой
  // toLocaleDateString с локалью из i18n.
  const fmtDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString(i18n.language || 'en', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return iso.slice(0, 10);
    }
  };

  return (
    <div className="studies-page" data-testid="studies-page">
      <header className="studies-page__header">
        <h1>{t('studies.title', 'Studies')}</h1>
        <p className="studies-page__subtitle">
          {t(
            'studies.subtitle',
            'Curate your analysis in shareable studies — your own and the community’s.',
          )}
        </p>
      </header>

      {user && (
        <div className="studies-page__toolbar" data-testid="studies-toolbar">
          <div
            className="studies-page__tabs"
            role="tablist"
            data-testid="studies-tabs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'mine'}
              className={`studies-page__tab${activeTab === 'mine' ? ' studies-page__tab--active' : ''}`}
              data-testid="studies-tab-mine"
              onClick={() => setTab('mine')}
            >
              {t('studies.tabs.mine', 'My studies')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'public'}
              className={`studies-page__tab${activeTab === 'public' ? ' studies-page__tab--active' : ''}`}
              data-testid="studies-tab-public"
              onClick={() => setTab('public')}
            >
              {t('studies.tabs.public', 'Public')}
            </button>
          </div>
          {/* KS-2852: кнопка «Создать студию» в правой части toolbar'а
              на вкладке «Мои» (для гостя не показываем — на «Публичные»
              тоже скрыто, т.к. там создавать нечего). */}
          {activeTab === 'mine' && (
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
      )}

      {loading && (
        <div className="studies-page__loading" data-testid="studies-loading">
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {error && !loading && (
        <div className="studies-page__error" data-testid="studies-error">
          {error}
        </div>
      )}

      {!loading && !error && studies.length === 0 && (
        <div className="studies-page__empty" data-testid="studies-empty">
          <p>
            {activeTab === 'mine'
              ? t(
                  'studies.empty.mine',
                  'You don’t have any studies yet. Create your first one to get started.',
                )
              : t(
                  'studies.empty.public',
                  'No public studies yet. Be the first to share.',
                )}
          </p>
          {/* KS-2852: дублирующий CTA в empty-state для «Мои». */}
          {user && activeTab === 'mine' && (
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

      {!loading && !error && studies.length > 0 && (
        <div className="studies-card-grid" data-testid="studies-grid">
          {studies.map((s) => (
            <Link
              key={s.id}
              to={`/studies/${encodeURIComponent(s.slug)}`}
              className="studies-card"
              data-testid={`studies-card-${s.slug}`}
            >
              <div className="studies-card__header">
                <span className="studies-card__name">{s.name}</span>
                <span
                  className={`studies-card__badge studies-card__badge--${s.isPublic ? 'public' : 'private'}`}
                  data-testid={`studies-card-badge-${s.slug}`}
                >
                  {s.isPublic
                    ? t('studies.card.public', 'Public')
                    : t('studies.card.private', 'Private')}
                </span>
              </div>
              {s.description && (
                <p className="studies-card__desc">{s.description}</p>
              )}
              <div className="studies-card__meta">
                <span className="studies-card__chapters">
                  {t('studies.card.chapters', {
                    count: s.chaptersCount,
                    defaultValue: '{{count}} chapter',
                    defaultValue_other: '{{count}} chapters',
                  })}
                </span>
                <span className="studies-card__updated">
                  {t('studies.card.updated', {
                    date: fmtDate(s.updatedAt),
                    defaultValue: 'Updated {{date}}',
                  })}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateStudyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(study) => {
            // После создания — переходим в новую студию (там
            // owner-actions сразу доступны для добавления глав).
            navigate(`/studies/${encodeURIComponent(study.slug)}`);
          }}
        />
      )}
    </div>
  );
}
