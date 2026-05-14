import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  studiesApi,
  type StudyDto,
  type StudyChapterSummaryDto,
} from '../api/studiesApi';
import { ImportPgnDialog } from '../components/studies/ImportPgnDialog';
import { ChapterList } from '../components/studies/ChapterList';
import { LikeButton } from '../components/studies/LikeButton';
import { StudyMembersDialog } from '../components/studies/StudyMembersDialog';

/**
 * KS-2826 (KS-2815 §B.5) — детальная страница студии `/studies/:slug`.
 *
 * Композиция:
 *  - Header: name + description + badge public/private.
 *  - Owner-actions: toggle public, импорт PGN (TODO KS-2830), создать
 *    главу, удалить студию.
 *  - Список глав (`ChapterList`-разметка) — пока без DnD (KS-2831
 *    добавит); каждый item — ссылка на `/studies/:slug/:chapterId`.
 *  - Пустое состояние (нет глав) — CTA «Создать первую главу».
 *
 * Доступ: owner видит свою студию; для публичной — кто угодно.
 * Backend `OptionalJwtAuthGuard` сам решает по `isPublic + ownerId`,
 * фронт просто рендерит ответ.
 */

export function StudyPage() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [study, setStudy] = useState<StudyDto | null>(null);
  const [chapters, setChapters] = useState<StudyChapterSummaryDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    null | 'create' | 'share' | 'delete'
  >(null);
  // KS-2830: модалка импорта multi-PGN.
  const [importOpen, setImportOpen] = useState<boolean>(false);
  // KS-2892 (FC7): модалка управления соавторами (owner-only).
  const [membersOpen, setMembersOpen] = useState<boolean>(false);

  const reload = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await studiesApi.getBySlug(slug);
      setStudy(resp.study);
      setChapters(resp.chapters);
    } catch {
      setError(t('studies.error.load', 'Failed to load study.'));
      setStudy(null);
      setChapters([]);
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!study) return;
    const prev = document.title;
    document.title = `${study.name} — ${t('studies.title', 'Studies')} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [study, t]);

  // KS-3014 / KS-3015: роль берём напрямую из backend response
  // (`study.viewerRole`). Раньше сравнивали `ownerId === user.id`,
  // что не различало contributor от viewer и игнорировало членство.
  const viewerRole = study?.viewerRole ?? 'anon';
  const isOwner = viewerRole === 'owner';
  const isContributor = viewerRole === 'contributor';
  // KS-3014: contributor имеет write-доступ к главам, но НЕ может
  // удалять студию, менять visibility, импортировать PGN или управлять
  // members. owner — полный набор. viewer/anon — read-only.
  const canEditChapters = isOwner || isContributor;

  const handleToggleShare = async () => {
    if (!study) return;
    setBusyAction('share');
    try {
      const updated = await studiesApi.share(study.slug, !study.isPublic);
      setStudy(updated);
    } catch {
      setError(t('studies.error.share', 'Failed to update sharing.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateChapter = async () => {
    if (!study) return;
    setBusyAction('create');
    try {
      const ch = await studiesApi.createChapter(study.slug, {
        name: t('studies.chapter.defaultName', 'New chapter'),
      });
      // Сразу ведём в редактор (KS-2827).
      navigate(`/studies/${encodeURIComponent(study.slug)}/${encodeURIComponent(ch.id)}`);
    } catch {
      setError(t('studies.error.createChapter', 'Failed to create chapter.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteStudy = async () => {
    if (!study) return;
    if (
      !window.confirm(
        t(
          'studies.confirm.delete',
          'Delete this study? Chapters will be lost. This cannot be undone.',
        ),
      )
    ) {
      return;
    }
    setBusyAction('delete');
    try {
      await studiesApi.delete(study.slug);
      navigate('/studies?tab=mine', { replace: true });
    } catch {
      setError(t('studies.error.delete', 'Failed to delete study.'));
      setBusyAction(null);
    }
  };

  if (loading) {
    return (
      <div className="study-page" data-testid="study-page" data-state="loading">
        <div className="studies-page__loading">{t('common.loading', 'Loading…')}</div>
      </div>
    );
  }

  if (error || !study) {
    return (
      <div className="study-page" data-testid="study-page" data-state="error">
        <div className="studies-page__error" data-testid="study-error">
          {error ?? t('studies.error.notFound', 'Study not found.')}
        </div>
        <Link to="/studies" className="study-page__back">
          ← {t('studies.backToCatalog', 'Back to studies')}
        </Link>
      </div>
    );
  }

  return (
    <div className="study-page" data-testid="study-page" data-state="ready">
      <nav className="study-page__breadcrumb">
        <Link to="/studies">{t('studies.title', 'Studies')}</Link>
        <span className="study-page__sep">/</span>
        <span aria-current="page">{study.name}</span>
      </nav>

      <header className="study-page__header">
        <div className="study-page__title-row">
          <h1 data-testid="study-page-name">{study.name}</h1>
          <span
            className={`studies-card__badge studies-card__badge--${study.isPublic ? 'public' : 'private'}`}
            data-testid="study-page-badge"
          >
            {study.isPublic
              ? t('studies.card.public', 'Public')
              : t('studies.card.private', 'Private')}
          </span>
          {/* KS-3014: индикатор роли в шапке. owner → синий бейдж;
              contributor → зелёный; viewer → серый «Read-only».
              Anon не получает бейджа вовсе — для гостя достаточно
              видеть, что owner-actions нет. */}
          {(viewerRole === 'owner' ||
            viewerRole === 'contributor' ||
            viewerRole === 'viewer') && (
            <span
              className={`studies-card__badge study-page__role-badge study-page__role-badge--${viewerRole}`}
              data-testid="study-page-role-badge"
              data-viewer-role={viewerRole}
            >
              {viewerRole === 'owner'
                ? t('studies.role.owner', 'Owner')
                : viewerRole === 'contributor'
                  ? t('studies.role.contributor', 'Contributor')
                  : t('studies.role.viewer', 'Read-only')}
            </span>
          )}
          {/* KS-2888 (FC3): кнопка лайка рядом с бейджем. Initial
              `liked` пока приходит как false — backend в B5/FC1
              расширит StudyDto полем `likedByMe`, и можно будет
              отдать сюда настоящее значение. */}
          <LikeButton
            slug={study.slug}
            studyId={study.id}
            likes={study.likes}
            liked={false}
            onChange={(s) =>
              setStudy((prev) =>
                prev ? { ...prev, likes: s.likes } : prev,
              )
            }
          />
        </div>
        {study.description && (
          <p className="study-page__desc">{study.description}</p>
        )}
      </header>

      {/* KS-3014: actions-блок виден только write-юзерам.
          - owner: share/create/import/members/delete;
          - contributor: только «+ New chapter» (без delete-study,
            share, import-pgn, members);
          - viewer/anon: блок не рендерится вовсе. */}
      {canEditChapters && (
        <div
          className="study-page__actions"
          data-testid="study-owner-actions"
          data-viewer-role={viewerRole}
        >
          {isOwner && (
            <button
              type="button"
              className="study-page__action"
              data-testid="study-action-share"
              disabled={busyAction === 'share'}
              onClick={handleToggleShare}
            >
              {study.isPublic
                ? t('studies.action.makePrivate', 'Make private')
                : t('studies.action.makePublic', 'Make public')}
            </button>
          )}
          <button
            type="button"
            className="study-page__action"
            data-testid="study-action-create-chapter"
            disabled={busyAction === 'create'}
            onClick={handleCreateChapter}
          >
            {t('studies.action.createChapter', '+ New chapter')}
          </button>
          {/* KS-2830: модалка multi-PGN импорта. После закрытия с
              успехом — `reload()` подтянет новые главы. */}
          {isOwner && (
            <button
              type="button"
              className="study-page__action"
              data-testid="study-action-import-pgn"
              onClick={() => setImportOpen(true)}
            >
              {t('studies.action.importPgn', 'Import PGN')}
            </button>
          )}
          {/* KS-2892 (FC7): соавторы — модалка с инвайтами/удалением.
              Только для owner'а (contributor видит, но не управляет). */}
          {isOwner && (
            <button
              type="button"
              className="study-page__action"
              data-testid="study-action-members"
              onClick={() => setMembersOpen(true)}
            >
              {t('studies.action.members', 'Members')}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              className="study-page__action study-page__action--danger"
              data-testid="study-action-delete"
              disabled={busyAction === 'delete'}
              onClick={handleDeleteStudy}
            >
              {t('studies.action.delete', 'Delete study')}
            </button>
          )}
        </div>
      )}

      {chapters.length === 0 ? (
        <div className="studies-page__empty" data-testid="study-chapters-empty">
          {canEditChapters
            ? t(
                'studies.empty.chaptersOwner',
                'No chapters yet. Create your first chapter or import a PGN.',
              )
            : t(
                'studies.empty.chaptersPublic',
                'This study has no chapters yet.',
              )}
        </div>
      ) : (
        <ChapterList
          slug={study.slug}
          chapters={chapters}
          // KS-3014: contributor тоже может править главы (read-write).
          canEdit={canEditChapters}
          onDeleted={() => {
            // KS-2912: после удаления главы пересчитываем список +
            // chaptersCount у study (через reload). ChapterList уже
            // сделал optimistic-remove, reload подтверждает с сервера.
            void reload();
          }}
        />
      )}

      {importOpen && (
        <ImportPgnDialog
          slug={study.slug}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            // После импорта подтягиваем обновлённый список глав.
            void reload();
          }}
        />
      )}

      {/* KS-2892 (FC7): соавторы. Открывается только владельцем. */}
      {membersOpen && (
        <StudyMembersDialog
          slug={study.slug}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </div>
  );
}
