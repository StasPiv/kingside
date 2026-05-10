import { api } from './api';
import type {
  PuzzleDto,
  PuzzleAttemptResponse,
  PuzzleAttemptResult,
  PuzzleRushReviewResponse,
  PuzzleRushBestMoveResponse,
  PlayVsEnginePuzzleReason,
} from '@kingside/shared';

// --- Request / Response types ---

export type PuzzleNextParams = {
  theme?: string;
  themes?: string[];
  ratingMin?: number;
  ratingMax?: number;
};

/**
 * KS-2719 / ADR-055 §3 + ADR-056 §4. Snapshot одного user-полухода в
 * play-vs-engine пазле — отправляется на backend как часть `moves[]`
 * payload в `submitAttempt`. Сервер использует server-trust:
 * пересчитывает classification (best/inaccuracy/mistake/blunder) и
 * accuracy% сам по cpBefore/cpAfter; клиентские классификации не
 * принимаются.
 *
 * Тип определён локально (а не в `@kingside/shared`), чтобы не
 * блокироваться backend-частью KS-2717 — пакет shared редактирует
 * только backend. Когда KS-2717 выкатится, поле перенесём в shared
 * `PuzzleAttemptRequest` и тут импорт.
 *
 * Поля совпадают с `UserBestSnapshot` из `PlayVsEngineRunner` (тот же
 * shape, без `halfMove` — backend сам пронумерует ходы по позиции в
 * массиве).
 */
export type PrecisionAttemptMoveSnapshot = {
  /** 1-based номер полухода в попытке (соответствует halfMove на клиенте). */
  ply: number;
  /** FEN, в котором ходил юзер (до его хода). */
  fenBefore: string;
  /** UCI, который юзер сыграл. */
  playedUci: string;
  /** UCI, рекомендованный движком в той же позиции (PV1 pre-analyze). */
  bestUci: string;
  /** cp POV user в `fenBefore` (mate кодируется ±100000). */
  cpBefore: number | null;
  /** cp POV user в позиции ПОСЛЕ playedUci. */
  cpAfter: number | null;
  /** WDL POV user в `fenBefore` (после bestUci — это PV1). */
  wdlBefore: { w: number; d: number; l: number } | null;
  /** WDL POV user в позиции после playedUci. */
  wdlAfter: { w: number; d: number; l: number } | null;
  /** Глубина анализа Stockfish, на которой сняты cpBefore/wdlBefore. */
  depth: number | null;
};

/**
 * KS-2466 / ADR-044 §5.4: для `play-vs-engine` пазлов фронт передаёт
 * дополнительные опц. поля. Бэк (KS-2465) принимает их и пока только
 * логирует — в БД не пишет (PuzzleAttempt.metadata — v2). Для классики
 * `forced-line` поля не передаются.
 *
 * KS-2719 / ADR-056 §4 F1: добавлено поле `moves[]` для server-trust
 * accuracy. Backend (KS-2717) принимает его и пишет per-move записи в
 * PrecisionAttemptMove + считает агрегаты в PrecisionAttempt. До выкатки
 * backend поле просто игнорируется на сервере (опциональное).
 */
export type PuzzleAttemptRequest = {
  result: PuzzleAttemptResult;
  timeMs: number;
  userMoves?: string;
  halfMovesPlayed?: number;
  finalWdl?: number;
  reason?: PlayVsEnginePuzzleReason;
  moves?: PrecisionAttemptMoveSnapshot[];
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

export type PuzzleRushStartResponse = {
  sessionId: string;
  puzzle: { fen: string; rating: number; moves: string };
  timeMode: string;
  durationMs: number;
  lives: number;
};

export type PuzzleRushSolveResponse = {
  correct: boolean;
  score: number;
  lives: number;
  finished: boolean;
  nextPuzzle: { fen: string; rating: number; setupMove?: string } | null;
  expectedMove?: string;
  scoreId?: string;
};

export type PuzzleRushLeaderboardParams = {
  timeMode?: '3' | '5';
  limit?: number;
};

// --- API client ---

export const puzzleApi = {
  /** Get next puzzle matched to user rating */
  getNext: (params?: PuzzleNextParams) => {
    const q = new URLSearchParams();
    if (params?.theme) q.set('theme', params.theme);
    if (params?.themes?.length) q.set('themes', params.themes.join(','));
    if (params?.ratingMin != null) q.set('ratingMin', String(params.ratingMin));
    if (params?.ratingMax != null) q.set('ratingMax', String(params.ratingMax));
    const qs = q.toString();
    return api.get<PuzzleDto>(`/puzzles/next${qs ? `?${qs}` : ''}`);
  },

  /** Get puzzle by ID */
  getById: (id: string) =>
    api.get<PuzzleDto>(`/puzzles/${encodeURIComponent(id)}`),

  /** Submit puzzle attempt result */
  submitAttempt: (puzzleId: string, body: PuzzleAttemptRequest) =>
    api.post<PuzzleAttemptResponse>(`/puzzles/${encodeURIComponent(puzzleId)}/attempts`, body),

  /** Start a new puzzle rush session */
  startRush: (body: PuzzleRushStartRequest) =>
    api.post<PuzzleRushStartResponse>('/puzzle-rush/start', body),

  /** Get current puzzle rush session */
  getRushSession: () =>
    api.get('/puzzle-rush/session'),

  /** Submit a move in puzzle rush */
  solveRush: (body: PuzzleRushSolveRequest) =>
    api.post<PuzzleRushSolveResponse>('/puzzle-rush/solve', body),

  /** End current puzzle rush session */
  endRushSession: () =>
    api.delete<{ score: number; timeMode: string; isHighScore: boolean; scoreId?: string }>('/puzzle-rush/session'),

  /** Get puzzle rush leaderboard */
  getRushLeaderboard: (params?: PuzzleRushLeaderboardParams) => {
    const query = new URLSearchParams();
    if (params?.timeMode) query.set('timeMode', params.timeMode);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return api.get(`/puzzle-rush/leaderboard${qs ? `?${qs}` : ''}`);
  },

  /** Get user's best puzzle rush result */
  getRushBest: (timeMode?: '3' | '5') => {
    const query = timeMode ? `?timeMode=${timeMode}` : '';
    return api.get(`/puzzle-rush/best${query}`);
  },

  /** Get review data for a completed puzzle rush session */
  getRushReview: (scoreId: string) =>
    api.get<PuzzleRushReviewResponse>(`/puzzle-rush/review/${encodeURIComponent(scoreId)}`),

  /** Get best move for a specific puzzle in a review session */
  getRushBestMove: (scoreId: string, puzzleId: string) =>
    api.get<PuzzleRushBestMoveResponse>(`/puzzle-rush/review/${encodeURIComponent(scoreId)}/puzzle/${encodeURIComponent(puzzleId)}/best-move`),
};
