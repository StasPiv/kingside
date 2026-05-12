import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';

import { useAuth } from '../context/AuthContext';
import {
  studiesApi,
  type StudyChapterDto,
  type PublicChapterResponse,
} from '../api/studiesApi';
import { useReviewState } from '../review/useReviewState';
import {
  parseAnnotatedPgn,
  extractInitialAnnotations,
} from '../review/utils/PgnDeserializer';
import { ReviewMoveList } from '../review/components/ReviewMoveList';

/**
 * KS-2829 (KS-2815 §B.5) — публичная read-only страница главы
 * `/studies/c/:chapterId`. Без auth: backend `studiesPublic` отдаёт
 * `{chapter, study}` если глава принадлежит публичной студии; иначе
 * 404 (фронт показывает not-found).
 *
 * Read-only: пользователь может листать дерево ходов (через MoveList
 * и навигационные кнопки), но не делать новые ходы. `ReviewMoveList`
 * с `readOnly` отключает контекстное меню/long-press, оставляя
 * клики для навигации.
 *
 * Если current user — owner этой студии, показываем доп. ссылку
 * «Открыть в редакторе» → `/studies/:slug/:chapterId` (полный
 * editor с editing-actions).
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function StudyChapterPublicPage() {
  const { t } = useTranslation();
  const { chapterId } = useParams<{ chapterId: string }>();
  const { user } = useAuth();

  const [data, setData] = useState<PublicChapterResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const review = useReviewState();

  const reload = useCallback(async () => {
    if (!chapterId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await studiesApi.getPublicChapter(chapterId);
      setData(resp);
      if (resp.chapter.pgn) {
        try {
          const moves = parseAnnotatedPgn(resp.chapter.pgn);
          const initialAnn = extractInitialAnnotations(resp.chapter.pgn);
          review.loadFromPgn(moves, initialAnn);
        } catch {
          /* битый PGN — оставляем дерево пустым */
        }
      }
      if (resp.chapter.startFen) {
        review.setInitialFen(resp.chapter.startFen);
      } else {
        review.setInitialFen(INITIAL_FEN);
      }
    } catch {
      setError(t('studies.error.notFound', 'Chapter not found.'));
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const chapter: StudyChapterDto | null = data?.chapter ?? null;
  const isOwner = Boolean(user && data && data.study.ownerId === user.id);

  useEffect(() => {
    if (!chapter || !data) return;
    const prev = document.title;
    document.title = `${chapter.name} — ${data.study.name} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [chapter, data]);

  if (loading) {
    return (
      <div className="study-editor-page" data-testid="study-public-page" data-state="loading">
        <div className="studies-page__loading">{t('common.loading', 'Loading…')}</div>
      </div>
    );
  }

  if (error || !chapter || !data) {
    return (
      <div className="study-editor-page" data-testid="study-public-page" data-state="error">
        <div className="studies-page__error" data-testid="study-public-error">
          {error ?? t('studies.error.notFound', 'Chapter not found.')}
        </div>
        <Link to="/studies" className="study-page__back">
          ← {t('studies.backToCatalog', 'Back to studies')}
        </Link>
      </div>
    );
  }

  return (
    <div className="study-editor-page" data-testid="study-public-page" data-state="ready">
      <nav className="study-page__breadcrumb">
        <Link to="/studies?tab=public">{t('studies.title', 'Studies')}</Link>
        <span className="study-page__sep">/</span>
        <span aria-current="page">
          {data.study.name} — {chapter.name}
        </span>
      </nav>

      <header className="study-editor-page__header">
        <h1
          data-testid="study-public-name"
          className="study-editor-page__name"
        >
          {chapter.name}
        </h1>
        {isOwner && (
          <Link
            to={`/studies/${encodeURIComponent(data.study.slug)}/${encodeURIComponent(chapter.id)}`}
            className="study-page__action"
            data-testid="study-public-open-editor"
          >
            {t('studies.action.openInEditor', 'Open in editor')}
          </Link>
        )}
      </header>

      <div className="study-editor-page__body">
        <div className="study-editor-page__board" data-testid="study-public-board">
          <Chessboard
            options={{
              position: review.currentFen,
              boardOrientation: chapter.orientation,
              allowDragging: false,
              animationDurationInMs: 0,
            }}
          />
          <div className="study-editor-page__nav">
            <button
              type="button"
              onClick={review.gotoFirst}
              data-testid="study-public-nav-first"
            >
              ⏮
            </button>
            <button
              type="button"
              onClick={review.gotoPrevious}
              data-testid="study-public-nav-prev"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={review.gotoNext}
              data-testid="study-public-nav-next"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={review.gotoLast}
              data-testid="study-public-nav-last"
            >
              ⏭
            </button>
          </div>
        </div>
        <aside className="study-editor-page__moves" data-testid="study-public-moves">
          <ReviewMoveList
            history={review.history}
            currentGlobalIndex={review.currentGlobalIndex}
            onMoveClick={review.gotoMove}
            readOnly
          />
        </aside>
      </div>
    </div>
  );
}
