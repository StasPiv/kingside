/**
 * KS-3606 (ADR-100 §9). Headless-логика «Разобрать партию», отделена
 * от UI-кнопки. Используется AnalysisPage чтобы поместить пункт
 * меню «Разобрать партию» в `AnalysisActionsMenu` без своего лишнего
 * UI-control'а в шапке engine-panel.
 *
 * Hook:
 *  - управляет state'ом модалки (`open` / `close`);
 *  - дергает `useGameReview.run(pgn)` по запросу;
 *  - на `status === 'done'` создаёт дубль через POST `/analyses/:id/
 *    duplicate-annotated` и редиректит.
 *  - возвращает `trigger()` (для item.onClick) и `modal` (готовый JSX
 *    для рендера в любом месте AnalysisPage).
 *
 * Caller (AnalysisPage) сам решает где рендерить модалку — обычно
 * сразу после items-block.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { api } from '../../api';
import { ApiError } from '../../ApiError';
import { useGameReview } from '../../hooks/useGameReview';
import { useGameReviewMovetime } from '../../hooks/useGameReviewMovetime';
import { applyAnnotationsToPgn } from '../../lib/review/applyAnnotationsToPgn';
import { GameReviewProgressModal } from './GameReviewProgressModal';

export interface UseGameReviewLauncherOptions {
  /** ID текущего открытого Analysis (для POST'а duplicate). null → no-op. */
  analysisId: string | null;
  /** Свежий PGN партии. Берётся в момент `trigger()`. */
  pgn: string;
  /**
   * Если != null — текущий Analysis уже авто-дубль. По §8.5 backend
   * сам резолвит target, но UX-чище — деактивировать пункт в меню.
   * Caller использует это поле в `disabled`-флаге item'а.
   */
  originalAnalysisId: string | null;
  /** Кол-во полуходов — для disable. */
  historyLength: number;
  /** ELO Maia (по умолчанию hook возьмёт 1500 / localStorage). */
  elo?: number;
  /** KS-3616. Название дебюта — пробрасывается в `extractFacts.openingName`. */
  openingName?: string | null;
}

export interface UseGameReviewLauncherResult {
  /** Запустить разбор. No-op если disabled-условие истинно. */
  trigger: () => void;
  /** Готовый JSX модалки прогресса — рендерить в AnalysisPage. */
  modal: ReactElement | null;
  /** Истина когда пункт меню должен быть disabled. */
  disabled: boolean;
  /** Tooltip для disabled-пункта. `undefined` если не disabled. */
  disabledHint: string | undefined;
  /**
   * KS-3616. `true` если фаза LLM-комментариев не вернула ни одного
   * непустого комментария — UI показывает toast/баннер «Комментарии
   * не сгенерированы». Дубль всё равно создаётся (NAG/variations).
   */
  commentsWarning: boolean;
}

export function useGameReviewLauncher(
  options: UseGameReviewLauncherOptions,
): UseGameReviewLauncherResult {
  const {
    analysisId,
    pgn,
    originalAnalysisId,
    historyLength,
    elo,
    openingName = null,
  } = options;
  const { t, i18n: i18nInstance } = useTranslation();
  const navigate = useNavigate();
  const userLanguage: 'en' | 'ru' = i18nInstance.language?.startsWith('ru')
    ? 'ru'
    : 'en';
  const { movetimeMs } = useGameReviewMovetime();
  const review = useGameReview({
    elo,
    openingName,
    userLanguage,
    movetimeMs,
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);
  // KS-3618: пока идёт POST /duplicate-annotated, модалка показывает
  // отдельную стадию «Создаю копию анализа…».
  const [creatingDuplicate, setCreatingDuplicate] = useState(false);

  const isDuplicate = originalAnalysisId != null;
  const disabled =
    isDuplicate ||
    historyLength === 0 ||
    !analysisId ||
    !pgn ||
    review.status === 'running';

  const disabledHint = isDuplicate
    ? t(
        'analysis.review.disabledOnDuplicate',
        'Open original analysis to re-run',
      )
    : historyLength === 0
      ? t('analysis.review.disabledEmpty', 'No moves to analyze')
      : undefined;

  const trigger = useCallback(() => {
    if (disabled) return;
    setCreateError(undefined);
    setModalOpen(true);
    void review.run(pgn);
  }, [disabled, pgn, review]);

  const handleCancel = useCallback(() => {
    review.cancel();
    setModalOpen(false);
  }, [review]);

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setCreateError(undefined);
    if (review.status !== 'running') review.reset();
  }, [review]);

  const handleRetry = useCallback(() => {
    setCreateError(undefined);
    if (review.status === 'error') void review.run(pgn);
  }, [review, pgn]);

  // POST дубль и redirect когда review закончил.
  useEffect(() => {
    if (review.status !== 'done') return;
    if (!review.result || !analysisId) return;
    let cancelled = false;
    setCreatingDuplicate(true);
    (async () => {
      try {
        // eslint-disable-next-line no-console
        console.log('[KS-3619] applyAnnotationsToPgn input PGN length:', pgn.length, 'annotations:', review.result!.annotations.length, 'commentByPly entries:', Object.keys(review.result!.commentByPly).length);
        const newPgn = applyAnnotationsToPgn(
          pgn,
          review.result!.annotations,
          { commentByPly: review.result!.commentByPly },
        );
        // eslint-disable-next-line no-console
        console.log('[KS-3619] applyAnnotationsToPgn output PGN length:', newPgn.length, 'tail:', newPgn.slice(-200));
        const created = await api.post<{ id: string }>(
          `/analyses/${analysisId}/duplicate-annotated`,
          {
            pgn: newPgn,
            titleSuffix: t(
              'analysis.review.duplicateSuffix',
              '(auto-annotation)',
            ),
          },
        );
        if (cancelled) return;
        setCreatingDuplicate(false);
        setModalOpen(false);
        navigate(`/analysis/${created.id}`);
      } catch (e) {
        if (cancelled) return;
        setCreatingDuplicate(false);
        if (e instanceof ApiError && e.status === 410) {
          setCreateError(
            t('analysis.auto.originalDeleted', 'Original deleted'),
          );
        } else {
          setCreateError(
            t(
              'analysis.review.createDuplicateError',
              'Failed to create duplicate',
            ),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [review.status, review.result, analysisId, pgn, navigate, t]);

  const modal = modalOpen ? (
    <GameReviewProgressModal
      open
      status={createError ? 'error' : review.status}
      done={review.progress.done}
      total={review.progress.total}
      stage={creatingDuplicate ? 'creating' : review.progress.stage}
      error={createError ?? review.error}
      onCancel={handleCancel}
      onClose={handleClose}
      onRetry={
        createError || review.status === 'error' ? handleRetry : undefined
      }
    />
  ) : null;

  return {
    trigger,
    modal,
    disabled,
    disabledHint,
    /** KS-3616. UI может показать локальный toast/баннер при `true`. */
    commentsWarning: review.commentsWarning,
  };
}
