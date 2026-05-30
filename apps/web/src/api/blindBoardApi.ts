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
};
