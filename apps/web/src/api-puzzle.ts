import { api } from './api';
import type {
  PuzzleDto,
  PuzzleAttemptRequest,
  PuzzleAttemptResponse,
  DailyPuzzleResponse,
  PuzzleRushStartRequest,
  PuzzleRushStartResponse,
  PuzzleRushAnswerRequest,
  PuzzleRushAnswerResponse,
  PuzzleRushNextResponse,
  PuzzleRushSessionResponse,
  PuzzleRushEndResponse,
  PuzzleRushLeaderboardResponse,
} from '@kingside/shared';

export type PuzzleNextParams = {
  theme?: string;
};

// --- API client ---

export const puzzleApi = {
  /** Get next puzzle matched to user rating */
  getNext: (params?: PuzzleNextParams & { excludeId?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.theme) searchParams.set('theme', params.theme);
    if (params?.excludeId) searchParams.set('excludeId', params.excludeId);
    const query = searchParams.toString();
    return api.get<PuzzleDto>(`/api/puzzles/next${query ? `?${query}` : ''}`);
  },

  /** Get puzzle by ID */
  getById: (id: string) =>
    api.get<PuzzleDto>(`/api/puzzles/${encodeURIComponent(id)}`),

  /** Submit puzzle attempt result */
  submitAttempt: (puzzleId: string, body: PuzzleAttemptRequest) =>
    api.post<PuzzleAttemptResponse>(`/api/puzzles/${encodeURIComponent(puzzleId)}/attempts`, body),

  /** Get today's daily puzzle */
  getDaily: () =>
    api.get<DailyPuzzleResponse>('/api/puzzles/daily'),

  /** Start a new puzzle rush session */
  startRush: (body: PuzzleRushStartRequest) =>
    api.post<PuzzleRushStartResponse>('/api/puzzles/rush', body),

  /** Submit a move (UCI) in puzzle rush */
  submitRushAnswer: (body: PuzzleRushAnswerRequest) =>
    api.post<PuzzleRushAnswerResponse>('/api/puzzles/rush/answer', body),

  /** Get current rush session state */
  getRushSession: () =>
    api.get<PuzzleRushSessionResponse>('/api/puzzles/rush/session'),

  /** Get next puzzle in rush session */
  getRushNext: () =>
    api.get<PuzzleRushNextResponse>('/api/puzzles/rush/next'),

  /** End rush session manually */
  endRushSession: () =>
    api.delete<PuzzleRushEndResponse>('/api/puzzles/rush/session'),

  /** Get rush leaderboard */
  getRushLeaderboard: (timeMode = '3', limit = 20) =>
    api.get<PuzzleRushLeaderboardResponse>(
      `/api/puzzles/rush/leaderboard?timeMode=${timeMode}&limit=${limit}`,
    ),

  /** Get user's best rush score */
  getRushBest: (timeMode = '3') =>
    api.get<number>(`/api/puzzles/rush/best?timeMode=${timeMode}`),
};
