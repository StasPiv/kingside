/**
 * KS-3411 (ADR-086 §9, F2). HTTP-клиент guess-the-move endpoints.
 *
 * Server-trust (ADR-086 §8): клиент шлёт RAW WDL POV side-to-move каждой
 * позиции (wdlBefore — выбранной стороны; wdlAfterPlayed/User — соперника),
 * сервер сам пересчитывает accuracy/verdict через `compareGuessMove`.
 *
 * Endpoints на прод выкатываются в финале эпика — до этого вызовы могут
 * вернуть 404; вызывающий код (GuessSessionRunner) при ошибке падает в
 * локальный режим (offline-подсчёт), поэтому фича работает и без backend.
 */
import { api } from '../api';
import type {
  FinishGuessSessionResponse,
  GetGuessSessionResponse,
  GuessHistoryResponse,
  GuessToAnalysisResponse,
  StartGuessSessionRequest,
  StartGuessSessionResponse,
  SubmitGuessMoveRequest,
  SubmitGuessMoveResponse,
} from '@kingside/shared';

const BASE = '/guess';

export const guessApi = {
  startSession(
    body: StartGuessSessionRequest,
  ): Promise<StartGuessSessionResponse> {
    return api.post<StartGuessSessionResponse>(`${BASE}/sessions`, body);
  },
  submitMove(
    sessionId: string,
    body: SubmitGuessMoveRequest,
  ): Promise<SubmitGuessMoveResponse> {
    return api.post<SubmitGuessMoveResponse>(
      `${BASE}/sessions/${sessionId}/move`,
      body,
    );
  },
  finishSession(sessionId: string): Promise<FinishGuessSessionResponse> {
    return api.post<FinishGuessSessionResponse>(
      `${BASE}/sessions/${sessionId}/finish`,
      {},
    );
  },
  getSession(sessionId: string): Promise<GetGuessSessionResponse> {
    return api.get<GetGuessSessionResponse>(`${BASE}/sessions/${sessionId}`);
  },
  history(): Promise<GuessHistoryResponse> {
    return api.get<GuessHistoryResponse>(`${BASE}/history`);
  },
  /**
   * KS-3461 (ADR-089 §6, KS-3460): создать (или вернуть) Analysis из
   * завершённой guess-сессии. Идемпотентно через
   * Analysis.guessSessionId UNIQUE: повторный клик отдаёт existing=true
   * и тот же analysisId.
   *
   * Accept-Language прокидывает api-клиент (см. ../api) — backend
   * выберет язык NAG-комментариев основной линии.
   */
  toAnalysis(sessionId: string): Promise<GuessToAnalysisResponse> {
    return api.post<GuessToAnalysisResponse>(
      `${BASE}/sessions/${sessionId}/to-analysis`,
      {},
    );
  },
  /**
   * KS-3530. Удаление сессии. Backend (cf6585c2): owner-check + cascade
   * по `GuessMove`. Если Analysis по этой сессии создан — он остаётся
   * (guessSessionId UNIQUE/null, см. /to-analysis). 204 No Content.
   */
  deleteSession(sessionId: string): Promise<void> {
    return api.delete<void>(`${BASE}/sessions/${sessionId}`);
  },
};

/**
 * ADR-086 §9 (F2). Канонические очки за ход по вердикту.
 * strongest 10 / betterThanPlayer 7 / asPlayer 5 / weaker 1.
 * Совпадают с серверной схемой; используются для локального подсчёта
 * (offline-режим / провизорный HUD до ответа сервера).
 */
export const GUESS_VERDICT_POINTS = {
  strongest: 10,
  betterThanPlayer: 7,
  asPlayer: 5,
  weaker: 1,
} as const;
