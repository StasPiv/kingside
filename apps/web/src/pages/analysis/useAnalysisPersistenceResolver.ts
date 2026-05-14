import type { ChessMove, NodeAnnotations } from '../../review/types';
import { useAnalysisPersistence } from '../../review/useAnalysisPersistence';
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
): void {
  // review: gameId передаётся только если ctx.kind === 'review' и не readOnly.
  const reviewGameId =
    ctx.kind === 'review' && !ctx.readOnly ? ctx.gameId : undefined;
  useAnalysisPersistence(
    reviewGameId,
    history,
    initialAnnotations,
    annotationsByIndex,
  );

  // analysis / puzzle — здесь не обрабатываем:
  // analysis: AnalysisPage делает create() при первом изменении, потом
  //   `useAdHocAnalysisAutosave` пишет в localStorage.
  // puzzle: ничего не сохраняем.
}
