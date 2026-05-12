import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';

import {
  studiesApi,
  type StudyChapterDto,
  type StudyDto,
} from '../api/studiesApi';
import type { GamebookPayload } from '@kingside/shared';
import { useReviewState } from '../review/useReviewState';
import {
  parseAnnotatedPgn,
  extractInitialAnnotations,
} from '../review/utils/PgnDeserializer';
import type { ChessMove } from '../review/types';
import { useFastDrag } from '../hooks/useFastDrag';

/**
 * KS-2874 (ADR-060 §3.3 R4 FM5) — gamebook reader.
 *
 * Route: `/studies/:slug/:chapterId/play`. Стандартный layout «доска +
 * текстовая панель снизу». Pre-game рендерит `chapter.gamebook.intro`
 * + кнопку «Старт». В игре:
 *
 * - правильный ход (main-line или вариант) → text из
 *   `gamebook.byUci[uci].success` или generic «Правильно»,
 *   opponent делает свой main-line ход через 250мс;
 * - неверный ход → `gamebook.byUci[uci].failure` или generic
 *   «Попробуйте другой ход», ход откатывается;
 * - конец main-line → «Вы прошли главу».
 *
 * Engine не задействован. Auto-save отключён (страница read-only).
 *
 * Загрузка — `studiesApi.getPublicChapter(chapterId)` (без auth, как
 * у public-readonly). Если глава не public — backend вернёт 404.
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function GamebookReaderPage() {
  const { t } = useTranslation();
  // KS-2907: slug определяет режим загрузки.
  // - /studies/:slug/:chapterId/play (slug есть) → авторизованный путь
  //   через getBySlug + getChapter. Owner приватной/unlisted студии
  //   получает свою главу.
  // - /studies/c/:chapterId/play (slug нет) → public-endpoint
  //   getPublicChapter (анонимный доступ для public-студий).
  const { slug, chapterId } = useParams<{
    slug?: string;
    chapterId: string;
  }>();

  const [study, setStudy] = useState<StudyDto | null>(null);
  const [chapter, setChapter] = useState<StudyChapterDto | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'intro' | 'playing' | 'finished'>('intro');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackKind, setFeedbackKind] = useState<'success' | 'failure' | null>(
    null,
  );

  const review = useReviewState();

  // Загрузка главы. Slug-роут — авторизованный путь (owner/contributor
  // приватной/unlisted студии). /c/-роут — public-endpoint (анонимные).
  useEffect(() => {
    if (!chapterId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const applyChapter = (
      respStudy: StudyDto,
      respChapter: StudyChapterDto,
    ) => {
      setStudy(respStudy);
      setChapter(respChapter);
      if (respChapter.startFen) {
        review.setInitialFen(respChapter.startFen);
      } else {
        review.setInitialFen(INITIAL_FEN);
      }
      if (respChapter.pgn) {
        try {
          review.loadFromPgn(
            parseAnnotatedPgn(respChapter.pgn),
            extractInitialAnnotations(respChapter.pgn),
          );
        } catch {
          /* битый PGN — оставляем дерево пустым */
        }
      }
    };

    const fetchChapter = async () => {
      try {
        if (slug) {
          // KS-2907: авторизованный путь — owner/contributor получает
          // свою главу даже если study=private/unlisted.
          const [studyResp, chRes] = await Promise.all([
            studiesApi.getBySlug(slug),
            studiesApi.getChapter(slug, chapterId),
          ]);
          if (cancelled) return;
          applyChapter(studyResp.study, chRes);
        } else {
          // /studies/c/:chapterId/play — анонимный путь.
          const resp = await studiesApi.getPublicChapter(chapterId);
          if (cancelled) return;
          applyChapter(resp.study as StudyDto, resp.chapter);
        }
      } catch {
        if (!cancelled)
          setError(t('studies.error.notFound', 'Chapter not found.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchChapter();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, chapterId, t]);

  useEffect(() => {
    if (!chapter || !study) return;
    const prev = document.title;
    document.title = `${chapter.name} — ${study.name} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [chapter, study]);

  // KS-2874: expected next move (main-line + variants) для валидации.
  const findExpectedMove = useCallback(
    (from: string, to: string): ChessMove | null => {
      let mainLine: ChessMove | null = null;
      const currentMove = review.currentMove;
      const history = review.history;
      if (currentMove === null) {
        if (history.length === 0) return null;
        mainLine = history[0] as ChessMove;
      } else {
        mainLine = (currentMove.next as ChessMove | null | undefined) ?? null;
      }
      if (!mainLine) return null;
      if (mainLine.from === from && mainLine.to === to) return mainLine;
      const variations = (mainLine.variations ?? []) as ChessMove[][];
      for (const branch of variations) {
        const head = branch[0];
        if (head && head.from === from && head.to === to) return head;
      }
      return null;
    },
    [review.currentMove, review.history],
  );

  const gamebook: GamebookPayload | null = chapter?.gamebook ?? null;

  const handlePieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare || phase !== 'playing') return false;

      const expected = findExpectedMove(sourceSquare, targetSquare);
      if (!expected) {
        // Wrong move: ищем failure-text по UCI той ноды, какой ОЖИДАЛОСЬ
        // двинуть (mainLine), либо generic.
        let mainLineExpected: ChessMove | null = null;
        if (review.currentMove === null) {
          mainLineExpected = (review.history[0] as ChessMove | undefined) ?? null;
        } else {
          mainLineExpected =
            (review.currentMove.next as ChessMove | null | undefined) ?? null;
        }
        const failure =
          (mainLineExpected &&
            gamebook?.byUci?.[mainLineExpected.lan]?.failure) ||
          t('studies.practice.wrongMove', 'Try a different move.');
        setFeedback(failure);
        setFeedbackKind('failure');
        return false;
      }

      // Правильный ход → success text + переходим на эту ноду.
      const successText =
        gamebook?.byUci?.[expected.lan]?.success ??
        t('studies.gamebook.correct', 'Correct!');
      setFeedback(successText);
      setFeedbackKind('success');
      review.gotoMove(expected);

      // Авто-ход «соперника» через 600мс — main-line continuation.
      const opponentNext = expected.next as ChessMove | null | undefined;
      if (opponentNext) {
        window.setTimeout(() => {
          review.gotoMove(opponentNext);
          // Если у opponentNext нет .next — глава пройдена.
          if (!opponentNext.next) {
            setPhase('finished');
          }
        }, 600);
      } else {
        // Нет continuation сразу → глава пройдена.
        setPhase('finished');
      }
      return true;
    },
    [phase, findExpectedMove, gamebook, t, review],
  );

  const boardContainerRef = useRef<HTMLDivElement>(null);
  useFastDrag(boardContainerRef, {
    onPieceDrop: handlePieceDrop,
    boardOrientation: chapter?.orientation ?? 'white',
    allowBothColors: true,
    enabled: !loading && phase === 'playing',
  });

  if (loading) {
    return (
      <div
        className="gamebook-reader-page"
        data-testid="gamebook-reader-page"
        data-state="loading"
      >
        <div className="studies-page__loading">
          {t('common.loading', 'Loading…')}
        </div>
      </div>
    );
  }

  if (error || !chapter || !study) {
    return (
      <div
        className="gamebook-reader-page"
        data-testid="gamebook-reader-page"
        data-state="error"
      >
        <div
          className="studies-page__error"
          data-testid="gamebook-reader-error"
        >
          {error ?? t('studies.error.notFound', 'Chapter not found.')}
        </div>
        <Link to="/studies" className="study-page__back">
          ← {t('studies.backToCatalog', 'Back to studies')}
        </Link>
      </div>
    );
  }

  // KS-2874: на главах с mode!=='gamebook' страница не предназначена —
  // показываем подсказку, но не блокируем (если кто-то открыл напрямую).
  const isGamebookChapter = chapter.mode === 'gamebook';

  return (
    <div
      className="gamebook-reader-page"
      data-testid="gamebook-reader-page"
      data-state="ready"
      data-phase={phase}
    >
      <nav className="study-page__breadcrumb">
        <Link to="/studies?tab=public">{t('studies.title', 'Studies')}</Link>
        <span className="study-page__sep">/</span>
        <Link to={`/studies/c/${encodeURIComponent(chapter.id)}`}>
          {chapter.name}
        </Link>
        <span className="study-page__sep">/</span>
        <span aria-current="page">{t('studies.gamebook.play', 'Play')}</span>
      </nav>

      <header className="gamebook-reader-page__header">
        <h1
          data-testid="gamebook-reader-name"
          className="gamebook-reader-page__name"
        >
          {chapter.name}
        </h1>
        {!isGamebookChapter && (
          <div
            className="gamebook-reader-page__warn"
            data-testid="gamebook-reader-not-gamebook"
            role="alert"
          >
            {t(
              'studies.gamebook.notGamebook',
              'This chapter is not a gamebook.',
            )}
          </div>
        )}
      </header>

      <div className="gamebook-reader-page__body">
        <div
          className="gamebook-reader-page__board"
          data-testid="gamebook-reader-board"
          ref={boardContainerRef}
        >
          <Chessboard
            options={{
              position: review.currentFen,
              boardOrientation: chapter.orientation,
              allowDragging: false,
              animationDurationInMs: 150,
              showNotation: true,
            }}
          />
        </div>

        <aside
          className="gamebook-reader-page__text"
          data-testid="gamebook-reader-text"
        >
          {phase === 'intro' && (
            <div
              className="gamebook-reader-page__intro"
              data-testid="gamebook-reader-intro"
            >
              {gamebook?.intro && (
                <div className="gamebook-reader-page__intro-text">
                  {gamebook.intro}
                </div>
              )}
              <button
                type="button"
                className="gamebook-reader-page__start"
                data-testid="gamebook-reader-start"
                onClick={() => {
                  // KS-2915: после loadFromPgn курсор стоит на последнем
                  // ходе main-line. Если не вернуть его на старт, читатель
                  // не сможет сыграть первый ход — handlePieceDrop ищет
                  // expected = currentMove.next, а в конце линии next=null.
                  review.gotoFirst();
                  setFeedback(null);
                  setFeedbackKind(null);
                  setPhase('playing');
                }}
              >
                {t('studies.gamebook.start', 'Start')}
              </button>
            </div>
          )}

          {phase === 'playing' && (
            <div
              className="gamebook-reader-page__feedback"
              data-testid="gamebook-reader-feedback"
              data-kind={feedbackKind ?? 'none'}
              role={feedbackKind === 'failure' ? 'alert' : 'status'}
            >
              {feedback ?? t('studies.gamebook.yourMove', 'Your move.')}
            </div>
          )}

          {phase === 'finished' && (
            <div
              className="gamebook-reader-page__finished"
              data-testid="gamebook-reader-finished"
            >
              {t('studies.gamebook.finished', 'You completed the chapter!')}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
