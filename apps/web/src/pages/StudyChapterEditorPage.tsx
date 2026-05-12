import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';

import { useAuth } from '../context/AuthContext';
import {
  studiesApi,
  type StudyChapterDto,
  type StudyDto,
} from '../api/studiesApi';
import { useReviewState } from '../review/useReviewState';
import {
  parseAnnotatedPgn,
  extractInitialAnnotations,
} from '../review/utils/PgnDeserializer';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import { useStudyChapterPersistence } from '../hooks/useStudyChapterPersistence';
import { useFastDrag } from '../hooks/useFastDrag';

/**
 * KS-2827 (KS-2815 §B.5, §A.4) — редактор главы студии
 * `/studies/:slug/:chapterId`.
 *
 * Переиспользует ядро `apps/web/src/review`:
 *  - `useReviewState` — дерево ходов + варианты + аннотации.
 *  - `parseAnnotatedPgn` / `extractInitialAnnotations` — загрузка PGN.
 *  - `ReviewMoveList` — рендер дерева ходов.
 *  - `useStudyChapterPersistence` — auto-save через
 *    `PATCH /api/studies/:slug/chapters/:chapterId` (debounce 1с).
 *
 * MVP-функциональность:
 *  - Header с inline-edit имени, ориентацией, delete.
 *  - Доска (react-chessboard) с возможностью делать ходы → новые
 *    варианты в дереве.
 *  - MoveList сбоку с кликом по ходу = goto.
 *  - Кнопки навигации (◀ ▶) и first/last.
 *
 * Read-only режим — если current user не owner: всё disabled (auto-save
 * не сохраняет). Для anonymous public-view — отдельная страница
 * `StudyChapterPublicPage` (KS-2829).
 *
 * Тонкости опущены до фоллоу-апов:
 *  - PgnHeadersModal / SetPositionModal — отдельный UX полировка.
 *  - NagPalette / стрелки — уже работают через `ReviewMoveList` для
 *    нот; интерактив на доске для рисования — в финале (или сразу
 *    через `useBoardHighlights`).
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function StudyChapterEditorPage() {
  const { t } = useTranslation();
  const { slug, chapterId } = useParams<{ slug: string; chapterId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [study, setStudy] = useState<StudyDto | null>(null);
  const [chapter, setChapter] = useState<StudyChapterDto | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [nameDraft, setNameDraft] = useState<string>('');
  const [editingName, setEditingName] = useState<boolean>(false);
  const [savingName, setSavingName] = useState<boolean>(false);

  const review = useReviewState();

  // Load chapter (через studyBySlug + getChapter).
  const reload = useCallback(async () => {
    if (!slug || !chapterId) return;
    setLoading(true);
    setError(null);
    try {
      const [studyResp, ch] = await Promise.all([
        studiesApi.getBySlug(slug),
        studiesApi.getChapter(slug, chapterId),
      ]);
      setStudy(studyResp.study);
      setChapter(ch);
      setNameDraft(ch.name);
      // KS-2854: ВАЖНО — порядок dispatch'ей. `SET_INITIAL_FEN`
      // сбрасывает history (см. useReviewState reducer). Если вызвать
      // его ПОСЛЕ `loadFromPgn`, все распарсенные ходы будут стёрты,
      // доска останется в стартовой позиции, MoveList — «No moves».
      // Поэтому сначала setInitialFen, потом loadFromPgn.
      if (ch.startFen) {
        review.setInitialFen(ch.startFen);
      } else {
        review.setInitialFen(INITIAL_FEN);
      }
      if (ch.pgn) {
        try {
          const moves = parseAnnotatedPgn(ch.pgn);
          const initialAnn = extractInitialAnnotations(ch.pgn);
          review.loadFromPgn(moves, initialAnn);
        } catch {
          /* битый PGN — оставляем пусто */
        }
      }
    } catch {
      setError(t('studies.error.notFound', 'Study not found.'));
    } finally {
      setLoading(false);
    }
    // KS-2827: deliberately one-shot at mount/route-change — мы НЕ
    // хотим что-нибудь перезагружать каждый раз когда меняется review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, chapterId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!chapter || !study) return;
    const prev = document.title;
    document.title = `${chapter.name} — ${study.name} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [chapter, study]);

  const isOwner = Boolean(user && study && study.ownerId === user.id);
  const canEdit = isOwner;

  // Auto-save PGN дерева. Без эффекта, если не owner / без токена.
  useStudyChapterPersistence(
    canEdit ? slug : undefined,
    canEdit ? chapterId : undefined,
    review.history,
    review.initialAnnotations,
    review.annotationsByIndex,
  );

  const handleSaveName = async () => {
    if (!slug || !chapter || !chapter.id) return;
    const next = nameDraft.trim();
    if (!next || next === chapter.name) {
      setEditingName(false);
      setNameDraft(chapter.name);
      return;
    }
    setSavingName(true);
    try {
      const updated = await studiesApi.updateChapter(slug, chapter.id, {
        name: next,
      });
      setChapter(updated);
      setEditingName(false);
    } catch {
      setError(t('studies.error.share', 'Failed to update sharing.'));
    } finally {
      setSavingName(false);
    }
  };

  const handleToggleOrientation = async () => {
    if (!slug || !chapter) return;
    const next: 'white' | 'black' =
      chapter.orientation === 'white' ? 'black' : 'white';
    try {
      const updated = await studiesApi.updateChapter(slug, chapter.id, {
        orientation: next,
      });
      setChapter(updated);
    } catch {
      /* ignore */
    }
  };

  const handleDeleteChapter = async () => {
    if (!slug || !chapter) return;
    if (
      !window.confirm(
        t(
          'studies.confirm.deleteChapter',
          'Delete this chapter? This cannot be undone.',
        ),
      )
    ) {
      return;
    }
    try {
      await studiesApi.deleteChapter(slug, chapter.id);
      navigate(`/studies/${encodeURIComponent(slug)}`, { replace: true });
    } catch {
      setError(t('studies.error.delete', 'Failed to delete chapter.'));
    }
  };

  // KS-2855: ref на board-container нужен для `useFastDrag` (он слушает
  // pointer events напрямую на DOM, минуя сломанный @dnd-kit-based
  // drag из react-chessboard@5). Тот же приём, что в `AnalysisPage`
  // и `PuzzleBoard` — стандартный `options.onPieceDrop` в этой версии
  // библиотеки не триггерится ни в Playwright, ни в браузере.
  const boardContainerRef = useRef<HTMLDivElement>(null);

  // KS-2855: handler принимает {sourceSquare, targetSquare} от useFastDrag.
  // `makeVariantMove(from, to, promotion?)` сам обновит дерево (главная
  // линия / вариант / нав на существующее продолжение). Возвращает
  // true если ход легален — это уже использует react-chessboard для
  // анимации, и useFastDrag для решения куда вернуть фигуру.
  const handlePieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!canEdit) return false;
      if (!targetSquare) return false;
      // Авто-promotion в ферзя для простоты MVP (промо-диалог — фоллоу-ап).
      return review.makeVariantMove(sourceSquare, targetSquare, 'q');
    },
    [canEdit, review],
  );

  // KS-2855: useFastDrag перехватывает pointerdown на фигурах внутри
  // boardContainerRef, рендерит ghost-element и шлёт onPieceDrop с
  // целевой клеткой. `allowBothColors: true` — в студии разрешаем
  // ходить обеими цветами (analysis-mode). enabled=canEdit — на
  // read-only viewer'ах drag не работает.
  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop: handlePieceDrop,
    boardOrientation: chapter?.orientation ?? 'white',
    allowBothColors: true,
    enabled: canEdit,
  });

  if (loading) {
    return (
      <div className="study-editor-page" data-testid="study-editor-page" data-state="loading">
        <div className="studies-page__loading">{t('common.loading', 'Loading…')}</div>
      </div>
    );
  }

  if (error || !chapter || !study) {
    return (
      <div className="study-editor-page" data-testid="study-editor-page" data-state="error">
        <div className="studies-page__error" data-testid="study-editor-error">
          {error ?? t('studies.error.notFound', 'Chapter not found.')}
        </div>
        <Link to="/studies" className="study-page__back">
          ← {t('studies.backToCatalog', 'Back to studies')}
        </Link>
      </div>
    );
  }

  return (
    <div className="study-editor-page" data-testid="study-editor-page" data-state="ready">
      <nav className="study-page__breadcrumb">
        <Link to="/studies">{t('studies.title', 'Studies')}</Link>
        <span className="study-page__sep">/</span>
        <Link to={`/studies/${encodeURIComponent(study.slug)}`}>
          {study.name}
        </Link>
        <span className="study-page__sep">/</span>
        <span aria-current="page">{chapter.name}</span>
      </nav>

      <header className="study-editor-page__header">
        {editingName ? (
          <input
            type="text"
            className="study-editor-page__name-input"
            data-testid="study-editor-name-input"
            value={nameDraft}
            disabled={savingName}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSaveName();
              else if (e.key === 'Escape') {
                setEditingName(false);
                setNameDraft(chapter.name);
              }
            }}
            onBlur={() => void handleSaveName()}
            autoFocus
          />
        ) : (
          <h1
            data-testid="study-editor-name"
            className={canEdit ? 'study-editor-page__name study-editor-page__name--editable' : 'study-editor-page__name'}
            onClick={() => canEdit && setEditingName(true)}
            title={canEdit ? t('studies.action.editName', 'Rename') : undefined}
          >
            {chapter.name}
          </h1>
        )}

        {canEdit && (
          <div className="study-editor-page__actions" data-testid="study-editor-actions">
            <button
              type="button"
              className="study-page__action"
              data-testid="study-editor-action-flip"
              onClick={handleToggleOrientation}
            >
              {t('studies.action.flipBoard', 'Flip board')} (
              {chapter.orientation === 'white'
                ? t('studies.orientation.white', 'White')
                : t('studies.orientation.black', 'Black')}
              )
            </button>
            <button
              type="button"
              className="study-page__action study-page__action--danger"
              data-testid="study-editor-action-delete"
              onClick={handleDeleteChapter}
            >
              {t('studies.action.deleteChapter', 'Delete chapter')}
            </button>
          </div>
        )}
      </header>

      <div className="study-editor-page__body">
        <div
          className="study-editor-page__board"
          data-testid="study-editor-board"
          ref={boardContainerRef}
        >
          <Chessboard
            options={{
              position: review.currentFen,
              boardOrientation: chapter.orientation,
              // KS-2855: drag через useFastDrag, не через
              // react-chessboard@5 (там API onPieceDrop не работает
              // ни в Playwright pointer-events, ни в браузере).
              allowDragging: false,
              animationDurationInMs: suppressAnimationRef.current ? 0 : 150,
              showNotation: true,
            }}
          />
          <div className="study-editor-page__nav">
            <button
              type="button"
              onClick={review.gotoFirst}
              data-testid="study-editor-nav-first"
            >
              ⏮
            </button>
            <button
              type="button"
              onClick={review.gotoPrevious}
              data-testid="study-editor-nav-prev"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={review.gotoNext}
              data-testid="study-editor-nav-next"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={review.gotoLast}
              data-testid="study-editor-nav-last"
            >
              ⏭
            </button>
          </div>
        </div>
        <aside className="study-editor-page__moves" data-testid="study-editor-moves">
          <ReviewMoveList
            history={review.history}
            currentGlobalIndex={review.currentGlobalIndex}
            onMoveClick={review.gotoMove}
            readOnly={!canEdit}
          />
        </aside>
      </div>
    </div>
  );
}
