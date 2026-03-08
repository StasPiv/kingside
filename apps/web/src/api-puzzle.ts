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
  timeLimitSec: 180 | 300;
};

export type PuzzleRushStartResponse = {
  session: {
    id: string;
    solved: number;
    failed: number;
    timeLimitSec: number;
    startedAt: string;
    finishedAt: string | null;
  };
  puzzle: { id: string; fen: string; moves: string[]; rating: number; themes: string[] };
};

export type PuzzleRushSessionResponse = {
  score: number;
  lives: number;
  timeMode: string;
  elapsedMs: number;
  durationMs: number;
  puzzle: { fen: string } | null;
};

export type PuzzleRushNextResponse = {
  puzzle: { id: string; fen: string; moves: string[]; rating: number };
  score: number;
  lives: number;
  elapsedMs: number;
  durationMs: number;
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

export type PuzzleRushLeaderboardEntry = {
  userId: string;
  username: string;
  score: number;
  createdAt: string;
};

export type PuzzleRushEndResponse = {
  score: number;
  timeMode: string;
  isHighScore: boolean;
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

  /** Get current session state */
  getRushSession: () =>
    api.get<PuzzleRushSessionResponse>('/api/puzzles/rush/session'),

  /** Prefetch current puzzle + session state */
  getRushNext: () =>
    api.get<PuzzleRushNextResponse>('/api/puzzles/rush/next'),

  /** Submit answer (UCI move) */
  submitRushAnswer: (body: PuzzleRushAnswerRequest) =>
    api.post<PuzzleRushAnswerResponse>('/api/puzzles/rush/answer', body),

  /** End session manually */
  endRush: () =>
    api.delete<PuzzleRushEndResponse>('/api/puzzles/rush/session'),

  /** Get leaderboard */
  getRushLeaderboard: (timeMode: string = '3', limit: number = 20) =>
    api.get<{ entries: PuzzleRushLeaderboardEntry[] }>(
      `/api/puzzles/rush/leaderboard?timeMode=${timeMode}&limit=${limit}`,
    ),

  /** Get user's best score */
  getRushBest: (timeMode: string = '3') =>
    api.get<number>(`/api/puzzles/rush/best?timeMode=${timeMode}`),
};
