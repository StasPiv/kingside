/**
 * KS-3603 (ADR-100 §9 этап B). Компонент-launcher для «Разобрать партию»:
 *  - кнопка в шапке/меню Sidebar'а;
 *  - модалка прогресса с cancel/retry;
 *  - POST `/analyses/:id/duplicate-annotated` по завершении;
 *  - redirect на новый Analysis.
 *
 * Caller передаёт `analysisId`, `pgn` и `disabled-флаги`. Хранение
 * pgn/analysisId — у caller'а (`AnalysisPage`), нам нужны только
 * актуальные значения на момент клика «Разобрать».
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useGameReview } from '../../hooks/useGameReview';
import { applyAnnotationsToPgn } from '../../lib/review/applyAnnotationsToPgn';
import { GameReviewProgressModal } from './GameReviewProgressModal';
import { api } from '../../api';
import { ApiError } from '../../ApiError';

export interface GameReviewLauncherProps {
  /** ID текущего открытого Analysis. `null` — кнопка disabled. */
  analysisId: string | null;
  /** Текущий PGN партии. */
  pgn: string;
  /**
   * Если != null — текущий Analysis это уже авто-дубль. По
   * правилам ADR §8.5 кнопка показывается, но disabled с tooltip
   * «открой исходный анализ». Альтернатива — backend сам резолвит
   * target = original.originalAnalysisId ?? id, но UX-чище сразу
   * отправить юзера в исходник.
   */
  originalAnalysisId: string | null;
  /** Кол-во ходов в партии. 0 → disabled. */
  historyLength: number;
  /** Полное disable извне (например, ещё не загружен Analysis). */
  disabled?: boolean;
  /** ELO Maia из настроек. По умолчанию hook возьмёт сам через 1500. */
  elo?: number;
}

interface DuplicateBody {
  pgn: string;
  titleSuffix: string;
}

export function GameReviewLauncher({
  analysisId,
  pgn,
  originalAnalysisId,
  historyLength,
  disabled,
  elo,
}: GameReviewLauncherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const review = useGameReview({ elo });
  const [modalOpen, setModalOpen] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const isDuplicate = originalAnalysisId != null;
  const tooltip = isDuplicate
    ? t(
        'analysis.review.disabledOnDuplicate',
        'Open original analysis to re-run',
      )
    : historyLength === 0
      ? t('analysis.review.disabledEmpty', 'No moves to analyze')
      : undefined;

  const btnDisabled =
    Boolean(disabled) ||
    isDuplicate ||
    historyLength === 0 ||
    !analysisId ||
    !pgn ||
    review.status === 'running';

  const handleClick = useCallback(() => {
    if (btnDisabled) return;
    setCreateError(undefined);
    setModalOpen(true);
    void review.run(pgn);
  }, [btnDisabled, pgn, review]);

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

  // Когда review.status === 'done' → создаём дубль и редиректим.
  useEffect(() => {
    if (review.status !== 'done') return;
    if (!review.result || !analysisId) return;
    let cancelled = false;
    (async () => {
      try {
        const newPgn = applyAnnotationsToPgn(pgn, review.result!.annotations);
        const created = await api.post<{ id: string }>(
          `/analyses/${analysisId}/duplicate-annotated`,
          {
            pgn: newPgn,
            titleSuffix: t(
              'analysis.review.duplicateSuffix',
              '(auto-annotation)',
            ),
          } satisfies DuplicateBody,
        );
        if (cancelled) return;
        setModalOpen(false);
        navigate(`/analysis/${created.id}`);
      } catch (e) {
        if (cancelled) return;
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

  return (
    <>
      <button
        type="button"
        className="analysis-review-btn"
        data-testid="analysis-review-btn"
        onClick={handleClick}
        disabled={btnDisabled}
        title={tooltip}
      >
        {t('analysis.review.runCta', 'Analyze game')}
      </button>
      <GameReviewProgressModal
        open={modalOpen}
        status={createError ? 'error' : review.status}
        done={review.progress.done}
        total={review.progress.total}
        error={createError ?? review.error}
        onCancel={handleCancel}
        onClose={handleClose}
        onRetry={createError || review.status === 'error' ? handleRetry : undefined}
      />
    </>
  );
}
