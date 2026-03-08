import { api } from './api';
import type { PuzzleDto, PuzzleAttempt, PuzzleAttemptResult } from '@kingside/shared';

// --- Request / Response types ---

export type PuzzleNextParams = {
  theme?: string;
};

export type PuzzleAttemptRequest = {
  result: PuzzleAttemptResult;
  timeMs: number;
};

export type DailyPuzzleResponse = {
  puzzle: PuzzleDto;
  date: string;
};

export type PuzzleRushStartRequest = {
  timeMode: '3' | '5';
};

export type PuzzleRushSession = {
  id: string;
  solved: number;
  failed: number;
  timeMode: '3' | '5';
  startedAt: string;
  finishedAt: string | null;
};

export type PuzzleRushSolveRequest = {
  uci: string;
};

export type PuzzleRushLeaderboardParams = {
  timeMode?: '3' | '5';
  limit?: number;
};

// --- API client ---

export const puzzleApi = {
  /** Get next puzzle matched to user rating */
  getNext: (params?: PuzzleNextParams) => {
    const query = params?.theme ? `?theme=${encodeURIComponent(params.theme)}` : '';
    return api.get<PuzzleDto>(`/api/puzzles/next${query}`);
  },

  /** Get puzzle by ID */
  getById: (id: string) =>
    api.get<PuzzleDto>(`/api/puzzles/${encodeURIComponent(id)}`),

  /** Submit puzzle attempt result */
  submitAttempt: (puzzleId: string, body: PuzzleAttemptRequest) =>
    api.post<PuzzleAttempt>(`/api/puzzles/${encodeURIComponent(puzzleId)}/attempt`, body),

  /** Get today's daily puzzle */
  getDaily: () =>
    api.get<DailyPuzzleResponse>('/api/puzzles/daily'),

  /** Start a new puzzle rush session */
  startRush: (body: PuzzleRushStartRequest) =>
    api.post('/api/puzzle-rush/start', body),

  /** Get current puzzle rush session */
  getRushSession: () =>
    api.get('/api/puzzle-rush/session'),

  /** Submit a move in puzzle rush */
  solveRush: (body: PuzzleRushSolveRequest) =>
    api.post('/api/puzzle-rush/solve', body),

  /** End current puzzle rush session */
  endRushSession: () =>
    api.delete('/api/puzzle-rush/session'),

  /** Get puzzle rush leaderboard */
  getRushLeaderboard: (params?: PuzzleRushLeaderboardParams) => {
    const query = new URLSearchParams();
    if (params?.timeMode) query.set('timeMode', params.timeMode);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return api.get(`/api/puzzle-rush/leaderboard${qs ? `?${qs}` : ''}`);
  },

  /** Get user's best puzzle rush result */
  getRushBest: (timeMode?: '3' | '5') => {
    const query = timeMode ? `?timeMode=${timeMode}` : '';
    return api.get(`/api/puzzle-rush/best${query}`);
  },
};
