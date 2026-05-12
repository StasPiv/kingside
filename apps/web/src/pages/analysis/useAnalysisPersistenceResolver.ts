import type { ChessMove, NodeAnnotations } from '../../review/types';
import { useAnalysisPersistence } from '../../review/useAnalysisPersistence';
import { useStudyChapterPersistence } from '../../hooks/useStudyChapterPersistence';
import type { AnalysisContext } from './AnalysisContext';

/**
 * KS-2867 (ADR-060 §3.1 FR4) — persistence-резолвер.
 *
 * AnalysisPage больше не вызывает `useAnalysisPersistence` напрямую —
 * вместо этого передаёт `ctx` сюда, а резолвер вызывает нужный
 * persistence-хук в зависимости от `ctx.kind`:
 *
 * - `review`  → `useAnalysisPersistence(gameId, ...)` — backend
 *                сохраняет `analysisPgn` к партии (`PUT /games/:id/analysis`).
 * - `analysis` → no-op здесь; AnalysisPage сам управляет
 *                `useSavedAnalyses` + `useAdHocAnalysisAutosave` (это разные
 *                сценарии: создание новой записи vs autosave existing).
 * - `study`    → `useStudyChapterPersistence(slug, chapterId, ...)` —
 *                `PATCH /api/studies/:slug/chapters/:chapterId`.
 * - `puzzle`   → no-op (puzzle-from-FEN не сохраняется).
 *
 * ВАЖНО — React-rules: хуки вызываются БЕЗУСЛОВНО. Каждый хук сам
 * no-op'ает когда его id (gameId / chapterId) undefined. Передаём
 * undefined для не-совпадающих веток.
 *
 * Read-only режим (`ctx.readOnly === true`) тоже коротит запись:
 * не передаём id, хук no-op'ит. Это снимает необходимость в отдельной
 * проверке `if (!readOnly) save()` снаружи.
 */
export function useAnalysisPersistenceResolver(
  ctx: AnalysisContext,
  history: ChessMove[],
  initialAnnotations?: NodeAnnotations,
  annotationsByIndex?: Record<number, NodeAnnotations>,
  /**
   * KS-2871 (FM2): для chapter.mode in {practice, conceal, gamebook}
   * пользователь «играет» — попытки не сохраняются. AnalysisPage
   * передаёт `true` когда studyChapter.mode не === 'analysis'.
   * Применяется ВЫШЕ ctx.readOnly: даже в editor-роуте.
   */
  disabled = false,
): void {
  // review: gameId передаётся только если ctx.kind === 'review', не readOnly и не disabled.
  const reviewGameId =
    ctx.kind === 'review' && !ctx.readOnly && !disabled ? ctx.gameId : undefined;
  useAnalysisPersistence(
    reviewGameId,
    history,
    initialAnnotations,
    annotationsByIndex,
  );

  // study: slug+chapterId только в editor-режиме (readOnly/disabled выключает запись).
  const studySlug =
    ctx.kind === 'study' && !ctx.readOnly && !disabled ? ctx.slug : undefined;
  const studyChapterId =
    ctx.kind === 'study' && !ctx.readOnly && !disabled
      ? ctx.chapterId
      : undefined;
  useStudyChapterPersistence(
    studySlug,
    studyChapterId,
    history,
    initialAnnotations,
    annotationsByIndex,
  );

  // analysis / puzzle — здесь не обрабатываем:
  // analysis: AnalysisPage делает create() при первом изменении, потом
  //   `useAdHocAnalysisAutosave` пишет в localStorage. Перенос этой
  //   логики в резолвер требует доступ к useSavedAnalyses/setLocalIdRef,
  //   что сейчас слишком сильно связано с UI (FM-этапы упростят).
  // puzzle: ничего не сохраняем.
}
