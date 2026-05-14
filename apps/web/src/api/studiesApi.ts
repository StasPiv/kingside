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
  StudyMembersResponse,
  InviteMemberRequest,
  InviteLinkResponse,
  AcceptInviteResponse,
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
  // KS-2892 (FC7): members API.
  StudyMembersResponse,
  StudyMemberDto,
  InviteMemberRequest,
  InviteLinkResponse,
  AcceptInviteResponse,
  StudyMemberRole,
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

  /**
   * KS-2892 / ADR-060 §2.5 (FC7) — управление соавторами студии.
   *
   * Backend (B5) endpoints:
   *   • GET    /studies/:slug/members           → список members (owner + contributors)
   *   • POST   /studies/:slug/members           → пригласить по username/uuid
   *   • DELETE /studies/:slug/members/:userId   → убрать contributor'а
   *   • POST   /studies/:slug/invite-link       → одноразовая ссылка (TTL 7д)
   *   • POST   /studies/invites/:token/accept   → принять приглашение
   *
   * Все эндпоинты, кроме accept, требуют owner'а. Backend сам валидирует.
   */
  listMembers: (slug: string): Promise<StudyMembersResponse> =>
    api.get<StudyMembersResponse>(
      `/studies/${encodeURIComponent(slug)}/members`,
    ),

  inviteMember: (
    slug: string,
    req: InviteMemberRequest,
  ): Promise<StudyMembersResponse> =>
    api.post<StudyMembersResponse>(
      `/studies/${encodeURIComponent(slug)}/members`,
      req,
    ),

  removeMember: (slug: string, userId: string): Promise<void> =>
    api.delete<void>(
      `/studies/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    ),

  createInviteLink: (slug: string): Promise<InviteLinkResponse> =>
    api.post<InviteLinkResponse>(
      `/studies/${encodeURIComponent(slug)}/invite-link`,
      {},
    ),

  acceptInvite: (token: string): Promise<AcceptInviteResponse> =>
    api.post<AcceptInviteResponse>(
      `/studies/invites/${encodeURIComponent(token)}/accept`,
      {},
    ),

  /**
   * KS-2893 / ADR-060 §2.5 C5 (FC8) — preview приглашения по токену.
   *
   * GET `/studies/invites/:token` (если backend поддерживает) →
   * `InvitePreviewResponse` с метаинфой студии (имя, owner, описание) +
   * флагами `expired` / `used`. Anon вызов разрешён — backend сам
   * решает, что отдать без JWT.
   *
   * Frontend использует preview, если он доступен; иначе показывает
   * generic-UI «Press Accept to join». На стороне фронта 404 (endpoint
   * пока не выкачен в этом env) обрабатывается как «нет preview, но
   * accept может сработать» — кнопка остаётся активной.
   */
  getInvitePreview: (token: string): Promise<InvitePreviewResponse> =>
    api.get<InvitePreviewResponse>(
      `/studies/invites/${encodeURIComponent(token)}`,
    ),

  /**
   * KS-2891 / ADR-060 §3.6 (FC6) — Save-to-Study (one-shot).
   *
   * POST `/api/studies/from-analysis` (backend B9): создаёт студию
   * либо добавляет главу в существующую. Контракт см.
   * `CreateFromAnalysisRequest`. Requires JWT.
   */
  createFromAnalysis: (
    req: CreateFromAnalysisRequest,
  ): Promise<CreateFromAnalysisResponse> =>
    api.post<CreateFromAnalysisResponse>('/studies/from-analysis', req),

  /**
   * KS-2889 / ADR-060 §3.4 K6 (FC4) — студии конкретного автора.
   *
   * GET `/api/studies/by/:userId?includePrivate=1&page=N`. Anon видит
   * только public; владелец с `includePrivate=1` получает свои
   * private/unlisted. Backend (B8) проверяет JWT.sub === :userId.
   * Возвращает `{items, total, hasMore, owner: {id, username}}` —
   * `owner` нужен для шапки страницы без отдельного `/users/:id`-fetch.
   */
  listByUser: (
    userId: string,
    opts: { includePrivate?: boolean; page?: number } = {},
  ): Promise<StudyByUserResponse> => {
    const params = new URLSearchParams();
    if (opts.includePrivate) params.set('includePrivate', '1');
    if (opts.page != null) params.set('page', String(opts.page));
    const qs = params.toString();
    return api.get<StudyByUserResponse>(
      `/studies/by/${encodeURIComponent(userId)}${qs ? `?${qs}` : ''}`,
    );
  },

  /**
   * KS-2886 / ADR-060 §3.4 (FC1) — каталог студий.
   *
   * GET `/api/studies/catalog?sort=hot|new|updated|popular&q=&topic=&page=&mine=`.
   * Ответ — `{items, total, hasMore}` (offset-style). `sort`-значения
   * совпадают с табами в UI; `mine=1` сужает до студий текущего юзера
   * (требует JWT, иначе backend вернёт 401 → ловим в catch).
   * `facets=topics` пока используется как fallback при отсутствии
   * выделенного facets-endpoint'а: backend возвращает обычный items-
   * список, фронт собирает топ-topics из items на клиенте.
   */
  getCatalog: (opts: {
    sort?: 'hot' | 'new' | 'updated' | 'popular';
    q?: string;
    topic?: string;
    page?: number;
    mine?: boolean;
  } = {}): Promise<StudyCatalogResponse> => {
    const params = new URLSearchParams();
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.q) params.set('q', opts.q);
    if (opts.topic) params.set('topic', opts.topic);
    if (opts.page != null) params.set('page', String(opts.page));
    if (opts.mine) params.set('mine', '1');
    const qs = params.toString();
    return api.get<StudyCatalogResponse>(
      `/studies/catalog${qs ? `?${qs}` : ''}`,
    );
  },
};

/**
 * KS-2886 (FC1): ответ `/api/studies/catalog`. Тип объявлен здесь
 * (а не в `@kingside/shared`), потому что shared-types ещё не
 * расширены — backend B7 уехал в прод раньше синхронизации DTO.
 * После KS-289X (синхронизация shared) перенесём.
 */
export interface StudyCatalogResponse {
  items: StudyDto[];
  total: number;
  hasMore: boolean;
}

/**
 * KS-2889 (FC4): ответ `GET /api/studies/by/:userId`. Помимо items
 * отдаёт минимальный профиль владельца, чтобы фронт мог нарисовать
 * хедер «{username}'s studies» без второго запроса в /users/:id.
 */
export interface StudyByUserResponse {
  items: StudyDto[];
  total: number;
  hasMore: boolean;
  owner: { id: string; username: string };
}

/**
 * KS-2893 (FC8): ответ `GET /api/studies/invites/:token` — preview
 * приглашения. Backend пока в реализации; тип объявлен здесь, чтобы
 * фронт мог парсить ответ как только endpoint появится. Если backend
 * вернул 404 — фронт деградирует на «accept без preview».
 */
export interface InvitePreviewResponse {
  study: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    ownerUsername: string | null;
  };
  /** Срок действия токена истёк. UI показывает соответствующий error. */
  expired: boolean;
  /** Приглашение уже принято (или другим юзером, или текущим). */
  used: boolean;
}

/**
 * KS-2891 / ADR-060 §3.6 (FC6) — Save-to-Study payload.
 *
 * Backend (B9) принимает либо:
 *   • `analysisId` — UUID сохранённого анализа, либо
 *   • `pgn` + опц. `fen` — для ad-hoc анализа / puzzle-режима.
 *
 * Цель назначается одним из двух полей:
 *   • `studyId` — добавить главу в существующую студию, либо
 *   • `newStudyName` — создать новую студию с этим именем,
 *     текущая глава становится первой.
 *
 * Имя главы — `chapterName`; backend проставляет дефолт если поле
 * пустое.
 */
export interface CreateFromAnalysisRequest {
  studyId?: string;
  newStudyName?: string;
  analysisId?: string;
  pgn?: string;
  fen?: string;
  chapterName?: string;
}

export interface CreateFromAnalysisResponse {
  study: StudyDto;
  chapter: StudyChapterDto;
}
