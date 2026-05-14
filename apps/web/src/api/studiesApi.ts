/**
 * KS-2824 (KS-2815 §B.4) — HTTP-клиент Studies MVP.
 *
 * REST-endpoints (backend KS-2818/2819, api `e76a9d56`):
 *   GET    /studies?mine=0|1                                 — список (мои/публичные).
 *   POST   /studies                                          — создать студию.
 *   GET    /studies/:slug                                    — студия + главы (без PGN).
 *   PATCH  /studies/:slug                                    — обновить (name/desc/isPublic).
 *   DELETE /studies/:slug                                    — удалить.
 *   POST   /studies/:slug/chapters                           — добавить главу.
 *   GET    /studies/:slug/chapters/:chapterId                — глава целиком (с PGN).
 *   PATCH  /studies/:slug/chapters/:chapterId                — обновить главу.
 *   DELETE /studies/:slug/chapters/:chapterId                — удалить главу.
 *   PATCH  /studies/:slug/chapters/:chapterId/order          — перенести (`{after}`).
 *   POST   /studies/:slug/import-pgn                         — multi-PGN импорт.
 *   GET    /studies/:slug/export.pgn                         — экспорт студии (`{pgn}`).
 *   GET    /studies/:slug/chapters/:chapterId/export.pgn     — экспорт одной главы.
 *   GET    /studies/public                                   — публичный каталог.
 *   GET    /studies/public/c/:chapterId                      — публичная глава.
 *
 * Типы — из `@kingside/shared/types/studies` (backend KS-2818 вынес
 * после KS-2824 уточнения).
 */

import type {
  StudyDto,
  StudyChapterDto,
  StudyListResponse,
  StudyWithChaptersResponse,
  PublicChapterResponse,
  CreateStudyRequest,
  UpdateStudyRequest,
  CreateChapterRequest,
  UpdateChapterRequest,
  ReorderChapterRequest,
  ImportPgnRequest,
  ImportPgnResponse,
  StudyExportPgnResponse,
  ToggleLikeResponse,
} from '@kingside/shared';
import { api } from '../api';

// Реэкспортируем shared-типы под удобными именами — потребители вне
// этого модуля могут импортировать `from '../api/studiesApi'`, не
// зная про monorepo-слой.
export type {
  StudyDto,
  StudyChapterDto,
  StudyListResponse,
  StudyWithChaptersResponse,
  PublicChapterResponse,
  CreateStudyRequest,
  UpdateStudyRequest,
  CreateChapterRequest,
  UpdateChapterRequest,
  ReorderChapterRequest,
  ImportPgnRequest,
  ImportPgnResponse,
  StudyExportPgnResponse,
  StudyChapterSummaryDto,
  ShareStudyRequest,
  StudyChapterOrientation,
  StudyChapterMode,
  ToggleLikeResponse,
} from '@kingside/shared';

export const studiesApi = {
  /** Список студий. `mine=true` — только мои (требует auth). */
  list: (opts: { mine?: boolean } = {}): Promise<StudyListResponse> => {
    const qs = opts.mine ? '?mine=1' : '?mine=0';
    return api.get<StudyListResponse>(`/studies${qs}`);
  },

  getBySlug: (slug: string): Promise<StudyWithChaptersResponse> =>
    api.get<StudyWithChaptersResponse>(
      `/studies/${encodeURIComponent(slug)}`,
    ),

  create: (req: CreateStudyRequest): Promise<StudyDto> =>
    api.post<StudyDto>('/studies', req),

  update: (slug: string, req: UpdateStudyRequest): Promise<StudyDto> =>
    api.patch<StudyDto>(`/studies/${encodeURIComponent(slug)}`, req),

  delete: (slug: string): Promise<void> =>
    api.delete<void>(`/studies/${encodeURIComponent(slug)}`),

  /**
   * KS-2824: shortcut для toggle isPublic — реализован через PATCH-эндпоинт
   * (отдельного `/share` эндпоинта нет; backend принимает {isPublic} в
   * UpdateStudyRequest).
   */
  share: (slug: string, isPublic: boolean): Promise<StudyDto> =>
    api.patch<StudyDto>(`/studies/${encodeURIComponent(slug)}`, {
      isPublic,
    } as UpdateStudyRequest),

  // --- Главы ---

  getChapter: (slug: string, chapterId: string): Promise<StudyChapterDto> =>
    api.get<StudyChapterDto>(
      `/studies/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}`,
    ),

  createChapter: (
    slug: string,
    req: CreateChapterRequest,
  ): Promise<StudyChapterDto> =>
    api.post<StudyChapterDto>(
      `/studies/${encodeURIComponent(slug)}/chapters`,
      req,
    ),

  updateChapter: (
    slug: string,
    chapterId: string,
    req: UpdateChapterRequest,
  ): Promise<StudyChapterDto> =>
    api.patch<StudyChapterDto>(
      `/studies/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}`,
      req,
    ),

  /**
   * Reorder: `after: null` — переместить в начало; `after: <id>` —
   * встать сразу после указанной главы.
   */
  reorderChapter: (
    slug: string,
    chapterId: string,
    after: string | null,
  ): Promise<StudyChapterDto> =>
    api.patch<StudyChapterDto>(
      `/studies/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}/order`,
      { after } as ReorderChapterRequest,
    ),

  deleteChapter: (slug: string, chapterId: string): Promise<void> =>
    api.delete<void>(
      `/studies/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}`,
    ),

  /** Multi-PGN импорт: каждый game в `pgn` → отдельная глава. */
  importPgn: (slug: string, pgn: string): Promise<ImportPgnResponse> =>
    api.post<ImportPgnResponse>(
      `/studies/${encodeURIComponent(slug)}/import-pgn`,
      { pgn } as ImportPgnRequest,
    ),

  /** Экспорт всей студии (текст PGN в обёртке). */
  exportPgn: (slug: string): Promise<StudyExportPgnResponse> =>
    api.get<StudyExportPgnResponse>(
      `/studies/${encodeURIComponent(slug)}/export.pgn`,
    ),

  /** Экспорт одной главы. */
  exportChapterPgn: (
    slug: string,
    chapterId: string,
  ): Promise<StudyExportPgnResponse> =>
    api.get<StudyExportPgnResponse>(
      `/studies/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}/export.pgn`,
    ),

  // --- Публичный read-only доступ (без auth) ---

  /** Anonymous каталог публичных студий. */
  listPublic: (): Promise<StudyListResponse> =>
    api.get<StudyListResponse>('/studies/public'),

  /** Anonymous чтение одной главы по её id (+ метаданные родительской студии). */
  getPublicChapter: (chapterId: string): Promise<PublicChapterResponse> =>
    api.get<PublicChapterResponse>(
      `/studies/public/c/${encodeURIComponent(chapterId)}`,
    ),

  /**
   * KS-2888 / ADR-060 §3.4 K4 — toggle лайк студии. Один POST переключает
   * состояние; backend возвращает актуальное `{liked, likes}` (счётчик
   * денормализован в `study.likes`). Требует JWT — для гостей фронт
   * редиректит на /login с returnUrl ДО вызова.
   */
  toggleLike: (slug: string): Promise<ToggleLikeResponse> =>
    api.post<ToggleLikeResponse>(
      `/studies/${encodeURIComponent(slug)}/like`,
      {},
    ),
};
