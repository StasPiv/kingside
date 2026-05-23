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
  CreateOpeningRepertoireRequest,
  CreateOpeningRepertoireResponse,
  DeleteOpeningRepertoireResponse,
  GetOpeningRepertoireResponse,
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
};
