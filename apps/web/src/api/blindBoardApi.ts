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
// KS-4141: локальный движок для гостя — backend для !auth возвращает
// 204 (PF write по §11.13), Response.json() ломается на пустом теле.
// Гостю вообще не делаем сетевой запрос.
import {
  deleteGuestSession,
  getGuestLeaderboard,
  getGuestSession,
  isGuest,
  startGuestSession,
  submitGuestAnswer,
} from '../lib/blindBoardGuestEngine';

const BASE = '/blind-board';

export const blindBoardApi = {
  /**
   * KS-3488 (ADR-088 V2 §15): опциональный `body.config` — конфиг
   * прогрессивной сложности (startPieces / addOrder / memorizeTimeSec).
   * Если не передан, backend применит `DEFAULT_BLIND_BOARD_CONFIG`.
   *
   * KS-4141: гостю не делаем POST — генерируем сессию локально через
   * `blindBoardGuestEngine`. Backend для гостя по §11.13 отвечает 204
   * без тела → `api.post` падает на JSON.parse.
   */
  async startSession(
    body?: StartBlindBoardSessionRequest,
  ): Promise<StartBlindBoardSessionResponse> {
    if (isGuest()) return startGuestSession(body);
    return api.post<StartBlindBoardSessionResponse>(`${BASE}/sessions`, body ?? {});
  },
  async submitAnswer(
    sessionId: string,
    body: SubmitBlindBoardAnswerRequest,
  ): Promise<SubmitBlindBoardAnswerResponse> {
    if (isGuest()) return submitGuestAnswer(sessionId, body);
    return api.post<SubmitBlindBoardAnswerResponse>(
      `${BASE}/sessions/${sessionId}/answer`,
      body,
    );
  },
  async getLeaderboard(): Promise<BlindBoardLeaderboardResponse> {
    if (isGuest()) return getGuestLeaderboard();
    return api.get<BlindBoardLeaderboardResponse>(`${BASE}/leaderboard`);
  },
  /**
   * KS-3517. Review одной сессии. Owner-check + JwtAuth на backend.
   * Для finished возвращает `startPosition` (анти-чит §5 после
   * финала не действует); для active — `startPosition` отсутствует.
   */
  async getSession(sessionId: string): Promise<BlindBoardSessionReviewResponse> {
    if (isGuest()) return getGuestSession(sessionId);
    return api.get<BlindBoardSessionReviewResponse>(
      `${BASE}/sessions/${sessionId}`,
    );
  },
  /**
   * KS-3530. Удаление сессии. Backend (cf6585c2): owner-check + cascade
   * по `BlindBoardAttempt`. После удаления пересчитывает
   * `User.blindBoardBestStreak = max(...)` или 0. 204 No Content.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (isGuest()) {
      deleteGuestSession(sessionId);
      return;
    }
    return api.delete<void>(`${BASE}/sessions/${sessionId}`);
  },
};
