import { useEffect, useRef } from 'react';

import { studiesApi } from '../api/studiesApi';
import type { ChessMove, NodeAnnotations } from '../review/types';
import { serializeToAnnotatedPgn } from '../review/utils/PgnSerializer';

/**
 * KS-2827 (KS-2815 §B.5, §A.4) — auto-save главы студии.
 *
 * Копия `useAnalysisPersistence`, переключённая на endpoint
 * `PATCH /api/studies/:slug/chapters/:chapterId` через `studiesApi.updateChapter`.
 *
 * Debounce 1000 мс по любому изменению дерева ходов или аннотаций.
 * Сериализация — `serializeToAnnotatedPgn` (то же, что AnalysisPage).
 *
 * Не сохраняет когда:
 *   - `slug` / `chapterId` не заданы;
 *   - дерево пусто И нет initial-annotations (нечего сохранять);
 *   - токена в localStorage нет (гость — owner-actions недоступны).
 */
const DEBOUNCE_MS = 1000;

export function useStudyChapterPersistence(
  slug: string | undefined,
  chapterId: string | undefined,
  history: ChessMove[],
  initialAnnotations?: NodeAnnotations,
  annotationsByIndex?: Record<number, NodeAnnotations>,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<boolean>(false);
  const historyRef = useRef<ChessMove[]>(history);
  const initialAnnRef = useRef<NodeAnnotations | undefined>(initialAnnotations);
  const annByIdxRef = useRef<Record<number, NodeAnnotations> | undefined>(
    annotationsByIndex,
  );
  const slugRef = useRef<string | undefined>(slug);
  const chapterIdRef = useRef<string | undefined>(chapterId);

  useEffect(() => {
    historyRef.current = history;
    initialAnnRef.current = initialAnnotations;
    annByIdxRef.current = annotationsByIndex;
    slugRef.current = slug;
    chapterIdRef.current = chapterId;
  });

  useEffect(() => {
    if (!slug || !chapterId) return;
    if (history.length === 0 && !initialAnnotations) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    pendingSaveRef.current = true;

    timerRef.current = setTimeout(() => {
      pendingSaveRef.current = false;
      const pgn = serializeToAnnotatedPgn(
        history,
        initialAnnotations,
        annotationsByIndex,
      );
      void studiesApi
        .updateChapter(slug, chapterId, { pgn })
        .catch(() => {
          /* silent — не критично; следующее изменение перезапишет */
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [slug, chapterId, history, initialAnnotations, annotationsByIndex]);

  // Flush на unmount — если есть отложенный save, выполняем без debounce.
  useEffect(() => {
    return () => {
      if (!pendingSaveRef.current) return;
      const s = slugRef.current;
      const ch = chapterIdRef.current;
      if (!s || !ch) return;
      const h = historyRef.current;
      if (h.length === 0 && !initialAnnRef.current) return;
      const token = localStorage.getItem('token');
      if (!token) return;
      const pgn = serializeToAnnotatedPgn(
        h,
        initialAnnRef.current,
        annByIdxRef.current,
      );
      void studiesApi.updateChapter(s, ch, { pgn }).catch(() => undefined);
    };
  }, []);
}
