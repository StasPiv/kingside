import { Chess } from 'chess.js';

export type SourceMetadata = {
  white?: string;
  black?: string;
  event?: string;
  date?: string;
  result?: string;
  bestScore?: number;
  bestMove?: string;
  secondBestScore?: number;
  secondBestMove?: string;
};

export type GeneratedPuzzleData = {
  fen: string;
  moves: string; // space-separated UCI moves
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

type InfoLine = {
  multipv: number;
  depth: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string[];
};

function parseInfoLine(line: string): InfoLine | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);

  if (!depthMatch || !pvMatch) return null;

  const depth = parseInt(depthMatch[1], 10);
  const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
  const pv = pvMatch[1].split(/\s+/);

  let score: { type: 'cp' | 'mate'; value: number };
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  if (mateMatch) {
    score = { type: 'mate', value: parseInt(mateMatch[1], 10) };
  } else if (cpMatch) {
    score = { type: 'cp', value: parseInt(cpMatch[1], 10) };
  } else {
    return null;
  }

  return { depth, multipv, score, pv };
}

function scoreToCP(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') {
    // Differentiate by mate distance: mate in 1 = 10000, mate in 2 = 9900, etc.
    const dist = Math.abs(score.value);
    const base = 10000 - (dist - 1) * 100;
    return score.value > 0 ? base : -base;
  }
  return score.value;
}

function classifyThemes(gap: number, pv: string[], fen: string, isMate: boolean, mateDist: number): string[] {
  const themes: string[] = [];
  const chess = new Chess(fen);
  const pieces = chess.board().flat().filter(Boolean).length;

  // Mate themes
  if (isMate) {
    themes.push('mate');
    if (mateDist === 1) themes.push('mateIn1');
    else if (mateDist === 2) themes.push('mateIn2');
    else if (mateDist === 3) themes.push('mateIn3');
    else if (mateDist <= 5) themes.push('mateIn5');
  } else {
    if (gap >= 500) themes.push('crushing');
    else if (gap >= 300) themes.push('advantage');
  }

  // Length
  if (pv.length <= 2) themes.push('oneMove');
  else if (pv.length <= 4) themes.push('short');
  if (pv.length >= 10) themes.push('long');

  // Endgame
  if (pieces <= 10) themes.push('endgame');

  // Tactical detection
  try {
    const move = chess.move({ from: pv[0].slice(0, 2), to: pv[0].slice(2, 4), promotion: pv[0][4] });
    if (move?.captured) themes.push('capture');
    if (move?.san.includes('+')) themes.push('check');
    if (move?.san.includes('#')) themes.push('checkmate');
  } catch { /* ignore */ }

  if (themes.length === 0) themes.push('tactical');
  return themes;
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Estimate puzzle rating based on move type (obvious/standard/hard/brilliant) */
function estimateRating(fen: string, pv: string[], isMate: boolean, mateDist: number): number {
  const chess = new Chess(fen);
  const allMoves = chess.moves({ verbose: true });
  const solutionUci = pv[0];
  const from = solutionUci.slice(0, 2);
  const to = solutionUci.slice(2, 4);
  const promotion = solutionUci[4];

  const move = chess.move({ from, to, promotion });
  if (!move) return 1500;
  chess.undo();

  const isCapture = !!move.captured;
  const isCheck = move.san.includes('+') || move.san.includes('#');
  const isQuietMove = !isCapture && !isCheck;

  const opponent = move.color === 'w' ? 'b' : 'w';
  const isTargetDefended = chess.isAttacked(to as Parameters<typeof chess.isAttacked>[0], opponent);

  const movedPieceValue = PIECE_VALUE[move.piece] || 0;
  const capturedPieceValue = move.captured ? (PIECE_VALUE[move.captured] || 0) : 0;
  const isSacrifice = isTargetDefended && movedPieceValue > capturedPieceValue;
  const isBigSacrifice = isSacrifice && movedPieceValue >= 5;

  const isHangingCapture = isCapture && !isTargetDefended && capturedPieceValue >= 3;

  const temptingAlternatives = allMoves.filter(m =>
    (m.captured || m.san.includes('+')) &&
    !(m.from === from && m.to === to)
  ).length;

  let rating = 1200;

  if (isHangingCapture) {
    rating = 700;
  } else if (isCapture && !isTargetDefended) {
    rating = 800;
  } else if (isCapture && capturedPieceValue > movedPieceValue) {
    rating = 900;
  } else if (isCheck && !isQuietMove) {
    rating = 1000;
  } else if (isCapture) {
    rating = 1100;
  } else if (isCheck) {
    rating = 1200;
  } else if (isBigSacrifice) {
    rating = 1800;
  } else if (isSacrifice) {
    rating = 1600;
  } else if (isQuietMove) {
    rating = 1500;
  }

  const playerMoves = Math.ceil(pv.length / 2);
  rating += (playerMoves - 1) * 150;

  rating += Math.min(300, temptingAlternatives * 50);

  if (isMate && mateDist === 1) {
    rating = Math.min(rating, 1200);
  }

  return Math.min(2800, Math.max(600, Math.round(rating / 50) * 50));
}

/**
 * Analyze positions from a PGN game and find puzzles.
 * Uses a Stockfish WASM worker directly.
 */
export async function generatePuzzlesFromPgn(
  pgn: string,
  onProgress: (progress: GenerationProgress) => void,
  options: { depth?: number; multiPv?: number; gapThreshold?: number; abortSignal?: AbortSignal } = {},
): Promise<GeneratedPuzzleData[]> {
  const { depth = 14, multiPv = 3, gapThreshold = 25, abortSignal } = options;

  // Parse PGN into individual games
  const games = splitPgnIntoGames(pgn);
  const puzzles: GeneratedPuzzleData[] = [];

  // Create Stockfish worker
  // Use single-threaded build (works without cross-origin isolation)
  const worker = new Worker('/stockfish/stockfish-18-single.js');
  const sendCmd = (cmd: string) => worker.postMessage(cmd);

  worker.onerror = (err) => {
    console.error('[PuzzleGenerator] Worker error:', err);
  };

  // Wait for engine ready (timeout 15s)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Stockfish init timeout')), 15000);
    const handler = (e: MessageEvent) => {
      if (typeof e.data === 'string' && e.data.includes('uciok')) {
        clearTimeout(timer);
        worker.removeEventListener('message', handler);
        console.log('[PuzzleGenerator] Stockfish ready');
        resolve();
      }
    };
    worker.addEventListener('message', handler);
    sendCmd('uci');
  });

  sendCmd(`setoption name MultiPV value ${multiPv}`);
  sendCmd(`setoption name Threads value 1`);

  for (let gi = 0; gi < games.length; gi++) {
    if (abortSignal?.aborted) break;

    const gamePgn = games[gi];
    const chess = new Chess();
    try {
      chess.loadPgn(gamePgn);
    } catch {
      continue;
    }

    // Parse PGN headers for source metadata
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

    const moves = chess.history({ verbose: true });
    const positions: { fen: string; moveNum: number }[] = [];
    // Use FEN from PGN header if present, otherwise standard start
    const fenMatch = gamePgn.match(/\[FEN\s+"([^"]+)"\]/);
    const startFen = fenMatch ? fenMatch[1] : undefined;
    const replay = startFen ? new Chess(startFen) : new Chess();
    for (let i = 0; i < moves.length; i++) {
      positions.push({ fen: replay.fen(), moveNum: i + 1 });
      replay.move(moves[i].san);
    }

    for (let pi = 0; pi < positions.length; pi++) {
      if (abortSignal?.aborted) break;

      onProgress({
        gameIndex: gi,
        totalGames: games.length,
        positionIndex: pi,
        totalPositions: positions.length,
        puzzlesFound: puzzles.length,
      });

      const { fen, moveNum } = positions[pi];

      // Skip terminal positions (checkmate, stalemate, draw)
      try {
        const check = new Chess(fen);
        if (check.isGameOver()) continue;
        if (check.moves().length <= 1) continue; // skip forced moves
      } catch { continue; }

      // Single analysis with depth history tracking
      const analysis = await analyzePosition(worker, fen, depth, multiPv);
      if (analysis.lines.length === 0) continue;

      const best = analysis.lines[0];
      const bestMoveUci = best.pv[0];

      const bestCp = scoreToCP(best.score);
      const secondCp = analysis.lines.length >= 2 ? scoreToCP(analysis.lines[1].score) : 0;
      const gap = analysis.lines.length >= 2 ? Math.abs(bestCp - secondCp) : (best.score.type === 'mate' ? 10000 : 0);

      // Check if bestMove was obvious at low depths (1-6)
      const shallowThreshold = 6;
      let obviousAtShallow = false;
      for (let d = 1; d <= shallowThreshold; d++) {
        if (analysis.bestByDepth.get(d) === bestMoveUci) {
          obviousAtShallow = true;
          break;
        }
      }

      console.log(`[PuzzleGen] pos=${pi} bestMove=${bestMoveUci} firstAppear=${analysis.firstAppearance} obvious=${obviousAtShallow} gap=${gap} bestCp=${bestCp} secondCp=${secondCp}`);

      // Skip if best move was obvious at shallow depths
      if (obviousAtShallow) continue;

      // Skip positions where second best is already winning/losing (>300cp)
      if (analysis.lines.length >= 2 && Math.abs(secondCp) > 300) continue;

      // Check if best move is a sacrifice
      let isSacrifice = false;
      if (best.pv.length >= 1) {
        try {
          const testChess = new Chess(fen);
          const from = best.pv[0].slice(0, 2);
          const to = best.pv[0].slice(2, 4);
          const piece = testChess.get(from as Parameters<typeof testChess.get>[0]);
          if (piece && piece.type !== 'p') {
            const opponent = piece.color === 'w' ? 'b' : 'w';
            if (testChess.isAttacked(to as Parameters<typeof testChess.isAttacked>[0], opponent)) {
              isSacrifice = true;
            }
          }
        } catch { /* ignore */ }
      }

      const effectiveThreshold = isSacrifice ? Math.max(200, gapThreshold * 0.66) : gapThreshold;
      const isMate = best.score.type === 'mate';
      const mateDist = isMate ? Math.abs(best.score.value) : 0;

      if (gap >= effectiveThreshold && best.pv.length >= (isMate ? 1 : 2)) {
        const themes = classifyThemes(gap, best.pv, fen, isMate, mateDist);
        if (isSacrifice) themes.push('sacrifice');
        // Player solves 1 move; pass only pv[0] so playerMoves=1
        const rating = estimateRating(fen, [best.pv[0]], isMate, mateDist);

        // Use scores from THIS position's analysis (same side moves)
        const secondLine = analysis.lines.length >= 2 ? analysis.lines[1] : null;

        puzzles.push({
          fen,
          moves: best.pv.slice(0, 8).join(' '),
          rating,
          gap,
          themes: themes.join(' '),
          sourceType: 'pgn_import',
          sourceId: null,
          sourceMoveNum: moveNum,
          sourceMetadata: {
            ...metadata,
            bestScore: bestCp,
            bestMove: best.pv[0],
            secondBestScore: secondLine ? scoreToCP(secondLine.score) : undefined,
            secondBestMove: secondLine ? secondLine.pv[0] : undefined,
          },
        });
      }
    }
  }

  worker.terminate();
  return puzzles;
}

type AnalysisResult = {
  lines: InfoLine[];
  bestByDepth: Map<number, string>; // depth → bestMove UCI at that depth
  firstAppearance: number; // depth at which final bestMove first appeared
};

function analyzePosition(
  worker: Worker,
  fen: string,
  depth: number,
  multiPv: number,
): Promise<AnalysisResult> {
  return new Promise((resolve) => {
    const finalLines = new Map<number, InfoLine>();
    const bestByDepth = new Map<number, string>();

    const handler = (e: MessageEvent) => {
      const msg = typeof e.data === 'string' ? e.data : '';

      if (msg.startsWith('info') && msg.includes(' pv ')) {
        const info = parseInfoLine(msg);
        if (info) {
          // Track bestMove (multipv 1) at each depth
          if (info.multipv === 1) {
            bestByDepth.set(info.depth, info.pv[0]);
          }
          // Keep final lines for the target depth range
          if (info.depth >= depth - 2) {
            finalLines.set(info.multipv, info);
          }
        }
      }

      if (msg.startsWith('bestmove')) {
        worker.removeEventListener('message', handler);
        const lines = Array.from(finalLines.values()).sort((a, b) => a.multipv - b.multipv);
        const finalBest = lines.length > 0 ? lines[0].pv[0] : '';

        // Find first depth where finalBest appeared as best
        let firstAppearance = depth;
        for (let d = 1; d <= depth; d++) {
          if (bestByDepth.get(d) === finalBest) {
            firstAppearance = d;
            break;
          }
        }

        resolve({ lines, bestByDepth, firstAppearance });
      }
    };

    worker.addEventListener('message', handler);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
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
