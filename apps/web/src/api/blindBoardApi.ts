/**
 * KS-3442 (ADR-088 §11 F1). HTTP-клиент blind-board endpoints.
 *
 * B2 (KS-3441) уже в проде; все маршруты под JwtAuthGuard. Клиент
 * получает только {from,to} + агрегаты streak/round — полная позиция
 * сервером не раскрывается до wrong-answer / dead-end (анти-чит §5).
 */
import { api } from '../api';
import type {
  BlindBoardLeaderboardResponse,
  BlindBoardSessionReviewResponse,
  StartBlindBoardSessionRequest,
  StartBlindBoardSessionResponse,
  SubmitBlindBoardAnswerRequest,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

const BASE = '/blind-board';

export const blindBoardApi = {
  /**
   * KS-3488 (ADR-088 V2 §15): опциональный `body.config` — конфиг
   * прогрессивной сложности (startPieces / addOrder / memorizeTimeSec).
   * Если не передан, backend применит `DEFAULT_BLIND_BOARD_CONFIG`.
   */
  startSession(
    body?: StartBlindBoardSessionRequest,
  ): Promise<StartBlindBoardSessionResponse> {
    return api.post<StartBlindBoardSessionResponse>(`${BASE}/sessions`, body ?? {});
  },
  submitAnswer(
    sessionId: string,
    body: SubmitBlindBoardAnswerRequest,
  ): Promise<SubmitBlindBoardAnswerResponse> {
    return api.post<SubmitBlindBoardAnswerResponse>(
      `${BASE}/sessions/${sessionId}/answer`,
      body,
    );
  },
  getLeaderboard(): Promise<BlindBoardLeaderboardResponse> {
    return api.get<BlindBoardLeaderboardResponse>(`${BASE}/leaderboard`);
  },
  /**
   * KS-3517. Review одной сессии. Owner-check + JwtAuth на backend.
   * Для finished возвращает `startPosition` (анти-чит §5 после
   * финала не действует); для active — `startPosition` отсутствует.
   */
  getSession(sessionId: string): Promise<BlindBoardSessionReviewResponse> {
    return api.get<BlindBoardSessionReviewResponse>(
      `${BASE}/sessions/${sessionId}`,
    );
  },
  /**
   * KS-3530. Удаление сессии. Backend (cf6585c2): owner-check + cascade
   * по `BlindBoardAttempt`. После удаления пересчитывает
   * `User.blindBoardBestStreak = max(...)` или 0. 204 No Content.
   */
  deleteSession(sessionId: string): Promise<void> {
    return api.delete<void>(`${BASE}/sessions/${sessionId}`);
  },
};
