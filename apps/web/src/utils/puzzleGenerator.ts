import { Chess } from 'chess.js';
import type { EngineAdapter, BridgeConfig } from './engineAdapter';
import { WasmEngineAdapter, BridgeEngineAdapter } from './engineAdapter';

export type { BridgeConfig };

export type SourceMetadata = {
  white?: string;
  black?: string;
  event?: string;
  date?: string;
  result?: string;
};

export type GeneratedPuzzleData = {
  fen: string;
  moves: string; // space-separated UCI moves
  acceptedMoves?: string;
  rating: number;
  gap: number;
  themes: string;
  sourceType: string;
  sourceId: string | null;
  sourceMoveNum: number;
  sourceMetadata?: SourceMetadata;
};

export type GenerationProgress = {
  gameIndex: number;
  totalGames: number;
  positionIndex: number;
  totalPositions: number;
  puzzlesFound: number;
};

export interface PuzzleGenSettings {
  depth: number;
  multiPv: number;
  gapThreshold: number;
  maxSecondCp: number;
  skipHangingCapture: boolean;
  skipAttackedByLesser: boolean;
  skipUndefendedAfterMove: boolean;
  acceptedMoves: number;
}

export const DEFAULT_PUZZLE_GEN_SETTINGS: PuzzleGenSettings = {
  depth: 14,
  multiPv: 3,
  gapThreshold: 50,
  maxSecondCp: 300,
  skipHangingCapture: true,
  skipAttackedByLesser: true,
  skipUndefendedAfterMove: false,
  acceptedMoves: 1,
};

// --- Constants (matching server puzzle-worker) ---
const MIN_EVAL_DROP = 200;
const MIN_SPREAD = 150;
const MIN_MOVE_NUM = 10;
const MAX_SOLUTION_MOVES = 6;

function scoreToCp(s: { type: 'cp' | 'mate'; value: number }): number {
  return s.type === 'mate' ? (s.value > 0 ? 10000 : -10000) : s.value;
}

// --- Engine helpers ---

async function engineAnalyzeSingle(
  engine: EngineAdapter,
  fen: string,
  depth: number,
): Promise<{ bestMove: string; score: { type: 'cp' | 'mate'; value: number } }> {
  const result = await engine.analyze(fen, depth, 1);
  if (result.lines.length === 0) return { bestMove: '', score: { type: 'cp', value: 0 } };
  return { bestMove: result.lines[0].pv[0], score: result.lines[0].score };
}

async function engineAnalyzeMultiPV(
  engine: EngineAdapter,
  fen: string,
  depth: number,
  mpv: number,
): Promise<Array<{ bestMove: string; score: { type: 'cp' | 'mate'; value: number }; pv: string[] }>> {
  const result = await engine.analyze(fen, depth, mpv);
  return result.lines.map((l) => ({ bestMove: l.pv[0], score: l.score, pv: l.pv }));
}

// --- Solution line builder ---

async function buildSolutionLine(
  engine: EngineAdapter,
  fen: string,
  firstMove: string,
  depth: number,
): Promise<string> {
  const chess = new Chess(fen);
  const moves: string[] = [];
  try {
    chess.move({ from: firstMove.slice(0, 2), to: firstMove.slice(2, 4), promotion: firstMove.length > 4 ? firstMove[4] : undefined });
    moves.push(firstMove);

    for (let step = 1; step < MAX_SOLUTION_MOVES; step++) {
      if (chess.isGameOver()) break;
      const isSolver = step % 2 === 0;

      if (isSolver) {
        const mpv = await engineAnalyzeMultiPV(engine, chess.fen(), Math.min(depth, 14), 2);
        if (mpv.length < 1 || !mpv[0].bestMove || mpv[0].bestMove === '(none)') break;
        if (mpv.length >= 2 && Math.abs(scoreToCp(mpv[0].score) - scoreToCp(mpv[1].score)) < MIN_SPREAD) break;
        const bm = mpv[0].bestMove;
        chess.move({ from: bm.slice(0, 2), to: bm.slice(2, 4), promotion: bm.length > 4 ? bm[4] : undefined });
        moves.push(bm);
      } else {
        const a = await engineAnalyzeSingle(engine, chess.fen(), Math.min(depth, 14));
        if (!a.bestMove || a.bestMove === '(none)') break;
        chess.move({ from: a.bestMove.slice(0, 2), to: a.bestMove.slice(2, 4), promotion: a.bestMove.length > 4 ? a.bestMove[4] : undefined });
        moves.push(a.bestMove);
      }
    }
  } catch { /* invalid move */ }
  return moves.join(' ');
}

// --- Themes ---

function classifyThemes(fen: string, solutionMoves: string): string[] {
  const themes: string[] = [];
  const moves = solutionMoves.split(' ');
  const chess = new Chess(fen);

  // Endgame: <= 7 total pieces
  const pieces = fen.split(' ')[0].replace(/[0-9/]/g, '');
  if (pieces.length <= 7) themes.push('endgame');

  // Play through solution to check for mate
  try {
    for (const uci of moves) {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
    }
    if (chess.isCheckmate()) {
      const solverMoves = Math.ceil(moves.length / 2);
      if (solverMoves <= 3) themes.push(`mateIn${solverMoves}`);
      themes.push('mate');
    }
  } catch { /* invalid move sequence */ }

  // Fork: first solution move attacks >= 2 opponent pieces
  try {
    const forkChess = new Chess(fen);
    const firstUci = moves[0];
    forkChess.move({ from: firstUci.slice(0, 2), to: firstUci.slice(2, 4), promotion: firstUci.length > 4 ? firstUci[4] : undefined });
    const to = firstUci.slice(2, 4);
    const board = forkChess.board();
    const pieceColor = fen.split(' ')[1] === 'w' ? 'w' : 'b'; // solver's color
    let attackCount = 0;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = board[r][c];
        if (!sq || sq.color === pieceColor) continue;
        const sqName = String.fromCharCode(97 + c) + (8 - r);
        if (sqName === to) continue;
        const legalMoves = forkChess.moves({ square: to as any, verbose: true });
        if (legalMoves.some((m: any) => m.to === sqName)) attackCount++;
      }
    }
    if (attackCount >= 2) themes.push('fork');
  } catch { /* ignore */ }

  if (themes.length === 0) themes.push('tactical');
  return themes;
}

// --- Rating ---

function estimateRating(avgPlayerRating: number, evalDrop: number, solutionLength: number): number {
  let rating = avgPlayerRating;
  rating += (solutionLength - 4) * 100;
  if (evalDrop >= 500) rating -= 100;
  else if (evalDrop < 300) rating += 100;
  return Math.max(600, Math.min(2500, rating));
}

// --- PGN helpers ---

/** Strip comments {…}, variations (…), NAG ($1 etc), extra whitespace from PGN movetext */
function stripPgnAnnotations(pgn: string): string {
  const lines = pgn.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('[')) {
      result.push(line);
    } else {
      const cleaned = line
        .replace(/\{[^}]*\}/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\$\d+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      result.push(cleaned);
    }
  }
  return result.join('\n');
}

function splitPgnIntoGames(pgn: string): string[] {
  const games: string[] = [];
  const lines = pgn.split('\n');
  let current: string[] = [];
  let inGame = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[Event ') && current.length > 0 && inGame) {
      games.push(current.join('\n'));
      current = [];
      inGame = false;
    }
    if (trimmed.startsWith('[')) {
      inGame = true;
    }
    current.push(line);
  }

  if (current.length > 0) {
    games.push(current.join('\n'));
  }

  return games.filter((g) => g.trim().length > 0);
}

// --- Main generation function ---

export async function generatePuzzlesFromPgn(
  pgn: string,
  onProgress: (progress: GenerationProgress) => void,
  options: Partial<PuzzleGenSettings> & { abortSignal?: AbortSignal; bridgeConfig?: BridgeConfig } = {},
): Promise<GeneratedPuzzleData[]> {
  const settings = { ...DEFAULT_PUZZLE_GEN_SETTINGS, ...options };
  const { depth } = settings;
  const { abortSignal, bridgeConfig } = options;

  const games = splitPgnIntoGames(pgn);
  console.log('[PuzzleGen] PGN split into', games.length, 'games, input length:', pgn.length);
  const puzzles: GeneratedPuzzleData[] = [];

  // Create engine
  let engine: EngineAdapter;
  if (bridgeConfig) {
    engine = new BridgeEngineAdapter(bridgeConfig);
  } else {
    engine = new WasmEngineAdapter();
  }

  await engine.init();

  if (bridgeConfig) {
    engine.setOption('Threads', '16');
    engine.setOption('Hash', '256');
  } else {
    engine.setOption('Threads', '1');
  }

  for (let gi = 0; gi < games.length; gi++) {
    if (abortSignal?.aborted) break;

    const gamePgn = stripPgnAnnotations(games[gi]);
    const chess = new Chess();
    try {
      chess.loadPgn(gamePgn);
    } catch (e) {
      console.warn('[PuzzleGen] Failed to parse game', gi + 1, ':', e instanceof Error ? e.message : e);
      continue;
    }

    // Parse PGN headers for metadata
    const metadata: SourceMetadata = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let hMatch;
    while ((hMatch = headerRegex.exec(gamePgn)) !== null) {
      const [, key, value] = hMatch;
      if (key === 'White') metadata.white = value;
      else if (key === 'Black') metadata.black = value;
      else if (key === 'Event') metadata.event = value;
      else if (key === 'Date') metadata.date = value;
      else if (key === 'Result') metadata.result = value;
    }

    // Parse ratings from headers
    const whiteRatingMatch = gamePgn.match(/\[WhiteElo\s+"(\d+)"\]/);
    const blackRatingMatch = gamePgn.match(/\[BlackElo\s+"(\d+)"\]/);
    const whiteRating = whiteRatingMatch ? parseInt(whiteRatingMatch[1]) : 1500;
    const blackRating = blackRatingMatch ? parseInt(blackRatingMatch[1]) : 1500;
    const avgRating = Math.round((whiteRating + blackRating) / 2);

    const history = chess.history({ verbose: true });
    console.log('[PuzzleGen] Game', gi + 1, ':', history.length, 'moves');
    if (history.length < 20) {
      console.log('[PuzzleGen] Game', gi + 1, ': too short, skipping');
      continue;
    }

    // Reconstruct positions
    const replay = new Chess();
    const positions: Array<{ fenBefore: string; fenAfter: string; playedUci: string; moveNum: number }> = [];
    for (const move of history) {
      const fenBefore = replay.fen();
      const uci = move.from + move.to + (move.promotion ?? '');
      replay.move(move);
      positions.push({ fenBefore, fenAfter: replay.fen(), playedUci: uci, moveNum: positions.length + 1 });
    }

    const totalToAnalyze = Math.max(0, positions.length - 2 - MIN_MOVE_NUM);
    console.log('[PuzzleGen] Positions:', positions.length, 'Analyzing:', totalToAnalyze, '(from move', MIN_MOVE_NUM + 1, 'to', positions.length - 2, ')');

    for (let i = MIN_MOVE_NUM; i < positions.length - 2; i++) {
      if (abortSignal?.aborted) break;
      const pos = positions[i];
      const analyzeIndex = i - MIN_MOVE_NUM;

      onProgress({
        gameIndex: gi,
        totalGames: games.length,
        positionIndex: analyzeIndex,
        totalPositions: totalToAnalyze,
        puzzlesFound: puzzles.length,
      });

      // Step 1: Blunder detection — MultiPV 3 on position BEFORE the played move
      let analysis;
      try {
        analysis = await engineAnalyzeMultiPV(engine, pos.fenBefore, depth, 3);
      } catch (e) {
        console.error('[PuzzleGen] Engine error at move', pos.moveNum, ':', e);
        continue;
      }
      if (analysis.length < 1) continue;

      const bestScore = scoreToCp(analysis[0].score);
      const bestMove = analysis[0].bestMove;

      // Find the score of the played move
      let playedScore: number;
      const playedPV = analysis.find((a) => a.bestMove === pos.playedUci);
      if (playedPV) {
        playedScore = scoreToCp(playedPV.score);
      } else {
        // Played move not in top 3 — analyze position after move
        try {
          const pa = await engineAnalyzeSingle(engine, pos.fenAfter, Math.min(depth, 14));
          playedScore = -scoreToCp(pa.score); // flip perspective
        } catch {
          continue;
        }
      }

      const evalDrop = bestScore - playedScore;
      if (analyzeIndex % 5 === 0 || evalDrop >= MIN_EVAL_DROP) {
        console.log(`[PuzzleGen] move ${pos.moveNum}: best=${bestScore}cp played=${playedScore}cp drop=${evalDrop}cp`);
      }
      if (evalDrop < MIN_EVAL_DROP) continue;

      // Step 2: Spread check — MultiPV 2 on position AFTER the blunder
      let postAnalysis;
      try {
        postAnalysis = await engineAnalyzeMultiPV(engine, pos.fenAfter, depth, 2);
      } catch { continue; }
      if (postAnalysis.length < 2) continue;
      const spread = Math.abs(scoreToCp(postAnalysis[0].score) - scoreToCp(postAnalysis[1].score));
      if (spread < MIN_SPREAD) {
        console.log(`[PuzzleGen] move ${pos.moveNum}: skip spread=${spread}cp < ${MIN_SPREAD}`);
        continue;
      }

      // Step 3: Recapture filter
      const blunderTo = pos.playedUci.slice(2, 4);
      const solutionFirst = postAnalysis[0].bestMove;
      if (solutionFirst.slice(2, 4) === blunderTo) {
        console.log(`[PuzzleGen] move ${pos.moveNum}: skip recapture on ${blunderTo}`);
        continue;
      }

      // Step 4: Build forced solution line
      const solutionMoves = await buildSolutionLine(engine, pos.fenAfter, solutionFirst, depth);
      const moveCount = solutionMoves.split(' ').length;
      if (moveCount < 2) {
        console.log(`[PuzzleGen] move ${pos.moveNum}: skip short solution (${moveCount} moves)`);
        continue;
      }

      // Step 5: Rating
      const rating = estimateRating(avgRating, evalDrop, moveCount);

      // Step 6: Themes
      const themes = classifyThemes(pos.fenAfter, solutionMoves);

      console.log(`[PuzzleGen] PUZZLE: move ${pos.moveNum} drop=${evalDrop}cp spread=${spread}cp solution=${solutionMoves} rating=${rating} themes=${themes.join(',')}`);

      puzzles.push({
        fen: pos.fenAfter,
        moves: solutionMoves,
        rating,
        gap: spread,
        themes: themes.join(' '),
        sourceType: 'pgn_import',
        sourceId: null,
        sourceMoveNum: pos.moveNum,
        sourceMetadata: metadata,
      });
    }
  }

  engine.destroy();
  console.log('[PuzzleGen] Done. Total puzzles:', puzzles.length);
  return puzzles;
}
