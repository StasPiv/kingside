/**
 * KS-3273 (ADR-077 §6). HTTP-клиент для Opening Trainer endpoints.
 *
 * 12 endpoints на бэке (task-def 295):
 *   1. GET    /opening-trainer/repertoires            — список
 *   2. POST   /opening-trainer/repertoires            — создать
 *   3. GET    /opening-trainer/repertoires/:id        — карточка + tree
 *   4. PATCH  /opening-trainer/repertoires/:id        — обновить
 *   5. DELETE /opening-trainer/repertoires/:id        — soft-delete
 *   6. POST   /opening-trainer/repertoires/:id/sessions — старт сессии
 *   7. GET    /opening-trainer/sessions/:sid          — текущее состояние
 *   8. POST   /opening-trainer/sessions/:sid/move     — отправить ход
 *   9. POST   /opening-trainer/sessions/:sid/hint     — попросить подсказку
 *  10. POST   /opening-trainer/sessions/:sid/undo     — откатить полуход
 *  11. POST   /opening-trainer/sessions/:sid/giveup   — сдаться в позиции
 *  12. POST   /opening-trainer/sessions/:sid/finish   — закрыть сессию
 *
 * Все типы — из `@kingside/shared` (ADR-077 §3, KS-3269).
 */
import { api } from '../api';
import type {
  ArchiveGamesByPositionRequest,
  ArchiveGamesByPositionResponse,
  CreateOpeningRepertoireFromAnalysisRequest,
  CreateOpeningRepertoireRequest,
  CreateOpeningRepertoireResponse,
  CreateRepertoireSourceRequest,
  CreateRepertoireSourceResponse,
  DeleteOpeningRepertoireResponse,
  DeleteRepertoireSourceResponse,
  GetOpeningRepertoireActiveSessionResponse,
  GetOpeningRepertoireProgressResponse,
  GetOpeningRepertoireResponse,
  GetOpeningRepertoireStatsResponse,
  GetOpeningReviewsDueResponse,
  GetOpeningTrainerSessionResponse,
  ListOpeningRepertoiresResponse,
  OpeningTrainerFinishResponse,
  OpeningTrainerGiveupResponse,
  OpeningTrainerHintResponse,
  OpeningTrainerMoveRequest,
  OpeningTrainerMoveResponse,
  OpeningTrainerUndoResponse,
  StartOpeningTrainerSessionRequest,
  StartOpeningTrainerSessionResponse,
  UpdateOpeningRepertoireRequest,
  UpdateOpeningRepertoireResponse,
  UpdateRepertoireSourceRequest,
  UpdateRepertoireSourceResponse,
} from '@kingside/shared';

const BASE = '/opening-trainer';

export const openingTrainerApi = {
  // --- Repertoires ---
  listRepertoires(includeStats = false): Promise<ListOpeningRepertoiresResponse> {
    const qs = includeStats ? '?include=stats' : '';
    return api.get<ListOpeningRepertoiresResponse>(`${BASE}/repertoires${qs}`);
  },
  createRepertoire(
    body: CreateOpeningRepertoireRequest,
  ): Promise<CreateOpeningRepertoireResponse> {
    return api.post<CreateOpeningRepertoireResponse>(`${BASE}/repertoires`, body);
  },
  getRepertoire(id: string): Promise<GetOpeningRepertoireResponse> {
    return api.get<GetOpeningRepertoireResponse>(`${BASE}/repertoires/${id}`);
  },
  updateRepertoire(
    id: string,
    body: UpdateOpeningRepertoireRequest,
  ): Promise<UpdateOpeningRepertoireResponse> {
    return api.patch<UpdateOpeningRepertoireResponse>(
      `${BASE}/repertoires/${id}`,
      body,
    );
  },
  deleteRepertoire(id: string): Promise<DeleteOpeningRepertoireResponse> {
    return api.delete<DeleteOpeningRepertoireResponse>(`${BASE}/repertoires/${id}`);
  },

  // ── M2 (KS-3286) ──────────────────────────────────────────────────
  /** KS-3295 (F1). GET /repertoires/:id/progress — per-line статусы для счётчиков/tree-view. */
  getRepertoireProgress(id: string): Promise<GetOpeningRepertoireProgressResponse> {
    return api.get<GetOpeningRepertoireProgressResponse>(
      `${BASE}/repertoires/${id}/progress`,
    );
  },
  /** KS-3283. GET /repertoires/:id/stats — агрегатная статистика прохождения. */
  getRepertoireStats(id: string): Promise<GetOpeningRepertoireStatsResponse> {
    return api.get<GetOpeningRepertoireStatsResponse>(
      `${BASE}/repertoires/${id}/stats`,
    );
  },
  /** KS-3297 (F3). GET /repertoires/:id/active-session — sticky-карточка «продолжить». */
  getRepertoireActiveSession(
    id: string,
  ): Promise<GetOpeningRepertoireActiveSessionResponse> {
    return api.get<GetOpeningRepertoireActiveSessionResponse>(
      `${BASE}/repertoires/${id}/active-session`,
    );
  },
  /** KS-3298 (F4). GET /reviews/due — список линий по SRS-очереди, кросс-репертуарный. */
  getReviewsDue(): Promise<GetOpeningReviewsDueResponse> {
    return api.get<GetOpeningReviewsDueResponse>(`${BASE}/reviews/due`);
  },
  /** KS-3299 (F5). POST /repertoires/from-analysis — конверсия из мастерской. */
  createRepertoireFromAnalysis(
    body: CreateOpeningRepertoireFromAnalysisRequest,
  ): Promise<CreateOpeningRepertoireResponse> {
    return api.post<CreateOpeningRepertoireResponse>(
      `${BASE}/repertoires/from-analysis`,
      body,
    );
  },

  // ── KS-3469 (ADR-090 §4.2 B2) — proxy к archive-service ─────────
  /**
   * GET /opening-trainer/archive-position/games — мастер-партии 2400+
   * по позиции. Тонкая proxy-обёртка с defaults (minElo=2400,
   * sort=topElo, bucket=master, timeControlCategory=classical).
   * Любой default можно переопределить query-параметром (см. shared
   * ArchiveGamesByPositionRequest). Под JwtAuthGuard — гостям 401.
   */
  archivePositionGames(
    query: ArchiveGamesByPositionRequest,
  ): Promise<ArchiveGamesByPositionResponse> {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) sp.append(key, String(v));
      } else {
        sp.append(key, String(value));
      }
    }
    return api.get<ArchiveGamesByPositionResponse>(
      `${BASE}/archive-position/games?${sp.toString()}`,
    );
  },

  // ── KS-3324/3326 Multi-Source (ADR-078) ───────────────────────────
  /** POST /repertoires/:id/sources — добавить новый источник в существующий репертуар. */
  createRepertoireSource(
    repertoireId: string,
    body: CreateRepertoireSourceRequest,
  ): Promise<CreateRepertoireSourceResponse> {
    return api.post<CreateRepertoireSourceResponse>(
      `${BASE}/repertoires/${repertoireId}/sources`,
      body,
    );
  },
  /** PATCH /repertoires/:id/sources/:sourceId — обновить имя/PGN источника. */
  updateRepertoireSource(
    repertoireId: string,
    sourceId: string,
    body: UpdateRepertoireSourceRequest,
  ): Promise<UpdateRepertoireSourceResponse> {
    return api.patch<UpdateRepertoireSourceResponse>(
      `${BASE}/repertoires/${repertoireId}/sources/${sourceId}`,
      body,
    );
  },
  /** DELETE /repertoires/:id/sources/:sourceId — удалить источник (если не последний). */
  deleteRepertoireSource(
    repertoireId: string,
    sourceId: string,
  ): Promise<DeleteRepertoireSourceResponse> {
    return api.delete<DeleteRepertoireSourceResponse>(
      `${BASE}/repertoires/${repertoireId}/sources/${sourceId}`,
    );
  },

  // --- Sessions ---
  startSession(
    repertoireId: string,
    body: StartOpeningTrainerSessionRequest,
  ): Promise<StartOpeningTrainerSessionResponse> {
    return api.post<StartOpeningTrainerSessionResponse>(
      `${BASE}/repertoires/${repertoireId}/sessions`,
      body,
    );
  },
  getSession(sessionId: string): Promise<GetOpeningTrainerSessionResponse> {
    return api.get<GetOpeningTrainerSessionResponse>(`${BASE}/sessions/${sessionId}`);
  },
  sendMove(
    sessionId: string,
    body: OpeningTrainerMoveRequest,
  ): Promise<OpeningTrainerMoveResponse> {
    return api.post<OpeningTrainerMoveResponse>(
      `${BASE}/sessions/${sessionId}/move`,
      body,
    );
  },
  hint(sessionId: string): Promise<OpeningTrainerHintResponse> {
    return api.post<OpeningTrainerHintResponse>(
      `${BASE}/sessions/${sessionId}/hint`,
      {},
    );
  },
  undo(sessionId: string): Promise<OpeningTrainerUndoResponse> {
    return api.post<OpeningTrainerUndoResponse>(
      `${BASE}/sessions/${sessionId}/undo`,
      {},
    );
  },
  giveup(sessionId: string): Promise<OpeningTrainerGiveupResponse> {
    return api.post<OpeningTrainerGiveupResponse>(
      `${BASE}/sessions/${sessionId}/giveup`,
      {},
    );
  },
  finish(sessionId: string): Promise<OpeningTrainerFinishResponse> {
    return api.post<OpeningTrainerFinishResponse>(
      `${BASE}/sessions/${sessionId}/finish`,
      {},
    );
  },

  // ── KS-4160 / KS-4161 (ADR-128 §5): публичные демо-репертуары ─────
  /** GET /opening-trainer/demo — список демо-репертуаров (доступен гостю). */
  listDemoRepertoires(): Promise<DemoRepertoireSummary[]> {
    return api.get<DemoRepertoireSummary[]>(`${BASE}/demo`);
  },
  /** GET /opening-trainer/demo/:id — детали демо-репертуара (доступен гостю). */
  getDemoRepertoire(id: string): Promise<DemoRepertoireDetail> {
    return api.get<DemoRepertoireDetail>(
      `${BASE}/demo/${encodeURIComponent(id)}`,
    );
  },
};

/**
 * KS-4161: минимальный тип карточки демо-репертуара. Контракт детально
 * формализуется на стороне backend (KS-4160) — пока пакет shared его не
 * экспортирует, поэтому держим локально и читаем optionally.
 */
export type DemoRepertoireSummary = {
  id: string;
  title: string;
  description?: string;
  nodeCount?: number;
  edgeCount?: number;
  maxDepth?: number;
};

/**
 * KS-4161: тип детального ответа `/opening-trainer/demo/:id`. Гость
 * проигрывает SRS-сессию полностью локально, поэтому достаточно базовых
 * полей репертуара. До появления seed-контента ответ — 404.
 */
export type DemoRepertoireDetail = DemoRepertoireSummary & {
  /** Цвет, за который тренируется пользователь в этом репертуаре. */
  trainColor?: 'white' | 'black';
};
