import { api } from './api';
import type { PuzzleDto, PuzzleAttemptResult } from '@kingside/shared';

// --- Request / Response types ---

export type PuzzleNextParams = {
  theme?: string;
};

export type PuzzleAttemptRequest = {
  result: PuzzleAttemptResult;
  timeMs: number;
};

export type PuzzleAttemptResponse = {
  solved: boolean;
  puzzleRating: number;
  userRatingBefore: number;
  userRatingAfter: number;
  correctMoves: string[];
  nextPuzzle: PuzzleDto | null;
};

export type DailyPuzzleResponse = {
  puzzle: PuzzleDto;
  date: string;
};

export type PuzzleRushStartRequest = {
  timeMode: '3' | '5';
};

export type PuzzleRushSessionInfo = {
  id: string;
  solved: number;
  failed: number;
  timeLimitSec: number;
  startedAt: string;
  finishedAt: string | null;
};

export type PuzzleRushStartResponse = {
  session: PuzzleRushSessionInfo;
  puzzle: PuzzleDto;
};

export type PuzzleRushAnswerRequest = {
  uci: string;
};

export type PuzzleRushAnswerResponse = {
  correct: boolean;
  score: number;
  lives: number;
  finished: boolean;
  nextPuzzle: { fen: string; setupMove: string; rating: number } | null;
  expectedMove?: string;
};

export type PuzzleRushNextResponse = {
  puzzle: { id: string; fen: string; rating: number };
  score: number;
  lives: number;
  elapsedMs: number;
  durationMs: number;
};

export type PuzzleRushSessionResponse = {
  score: number;
  lives: number;
  timeMode: string;
  elapsedMs: number;
  durationMs: number;
  puzzle: { fen: string } | null;
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
    api.post<PuzzleRushStartResponse>('/api/puzzle-rush/start', body),

  /** Submit a move (UCI) in puzzle rush */
  submitRushAnswer: (body: PuzzleRushAnswerRequest) =>
    api.post<PuzzleRushAnswerResponse>('/api/puzzle-rush/answer', body),

  /** Get current rush session state */
  getRushSession: () =>
    api.get<PuzzleRushSessionResponse>('/api/puzzle-rush/session'),

  /** Get next puzzle in rush session */
  getRushNext: () =>
    api.get<PuzzleRushNextResponse>('/api/puzzle-rush/next'),

  /** End rush session manually */
  endRushSession: () =>
    api.delete<{ score: number; timeMode: string; isHighScore: boolean }>('/api/puzzle-rush/session'),

  /** Get rush leaderboard */
  getRushLeaderboard: (timeMode = '3', limit = 20) =>
    api.get<{ entries: { userId: string; username: string; score: number; createdAt: string }[] }>(
      `/api/puzzle-rush/leaderboard?timeMode=${timeMode}&limit=${limit}`,
    ),

  /** Get user's best rush score */
  getRushBest: (timeMode = '3') =>
    api.get<number>(`/api/puzzle-rush/best?timeMode=${timeMode}`),
};
