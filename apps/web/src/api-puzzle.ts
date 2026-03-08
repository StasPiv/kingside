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
  timeLimitSec: number;
};

export type PuzzleRushSession = {
  id: string;
  solved: number;
  failed: number;
  timeLimitSec: number;
  startedAt: string;
  finishedAt: string | null;
};

export type PuzzleRushNextResponse = {
  puzzle: PuzzleDto;
};

export type PuzzleRushResultRequest = {
  result: PuzzleAttemptResult;
  timeMs: number;
};

export type PuzzleRushResultResponse = {
  session: PuzzleRushSession;
  attempt: PuzzleAttempt;
  nextPuzzle: PuzzleDto | null;
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
    api.post<{ session: PuzzleRushSession; puzzle: PuzzleDto }>('/api/puzzles/rush', body),

  /** Submit puzzle rush attempt and get next puzzle */
  submitRushResult: (sessionId: string, body: PuzzleRushResultRequest) =>
    api.post<PuzzleRushResultResponse>(
      `/api/puzzles/rush/${encodeURIComponent(sessionId)}/attempts`,
      body,
    ),

  /** Get puzzle rush session history */
  getRushSessions: () =>
    api.get<PuzzleRushSession[]>('/api/puzzles/rush/history'),

  /** Get puzzle rush session by ID */
  getRushSession: (sessionId: string) =>
    api.get<PuzzleRushSession>(`/api/puzzles/rush/${encodeURIComponent(sessionId)}`),
};
