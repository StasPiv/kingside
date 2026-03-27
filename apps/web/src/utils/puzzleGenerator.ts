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

/** Estimate puzzle rating based on position complexity */
function estimateRating(fen: string, pv: string[], isMate: boolean, mateDist: number): number {
  const chess = new Chess(fen);
  const possibleMoves = chess.moves().length;
  const pieces = chess.board().flat().filter(Boolean).length;
  const solutionLength = pv.length;
  console.log('[estimateRating]', { possibleMoves, pieces, solutionLength, isMate, mateDist });

  if (isMate) {
    // Mate puzzles: base on mate distance + legal moves
    // M1 with few options = easy, M3 with many options = hard
    const base = 600 + mateDist * 300;
    const movesBonus = Math.min(400, possibleMoves * 15);
    return Math.min(2800, Math.max(600, base + movesBonus));
  }

  // Tactical puzzles: possibleMoves (complexity) + solutionLength + pieces
  const movesScore = possibleMoves * 12;       // more legal moves = harder to find the right one
  const lengthScore = solutionLength * 80;     // longer solution = harder
  const piecesScore = Math.max(0, pieces - 10) * 10; // more pieces = more complex
  return Math.min(2800, Math.max(600, 600 + movesScore + lengthScore + piecesScore));
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
  const { depth = 14, multiPv = 3, gapThreshold = 300, abortSignal } = options;

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
      } catch { continue; }

      // Analyze position
      const lines = await analyzePosition(worker, fen, depth, multiPv);
      if (lines.length === 0) continue;

      const best = lines[0];
      const bestCp = scoreToCP(best.score);
      // If only 1 line returned (e.g. forced mate), treat gap as huge
      const secondCp = lines.length >= 2 ? scoreToCP(lines[1].score) : 0;
      const gap = lines.length >= 2 ? Math.abs(bestCp - secondCp) : (best.score.type === 'mate' ? 10000 : 0);

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
        // Player solves 1 move, not the full PV continuation
        const rating = estimateRating(fen, best.pv.slice(0, 1), isMate, mateDist);

        // Analyze position AFTER setup move to get player's best/second moves
        let playerBestScore: number | undefined;
        let playerBestMove: string | undefined;
        let playerSecondScore: number | undefined;
        let playerSecondMove: string | undefined;
        try {
          const setupMove = best.pv[0];
          const afterSetup = new Chess(fen);
          afterSetup.move({ from: setupMove.slice(0, 2), to: setupMove.slice(2, 4), promotion: setupMove[4] });
          const playerLines = await analyzePosition(worker, afterSetup.fen(), Math.max(10, depth - 4), multiPv);
          if (playerLines.length >= 1) {
            playerBestScore = scoreToCP(playerLines[0].score);
            playerBestMove = playerLines[0].pv[0];
          }
          if (playerLines.length >= 2) {
            playerSecondScore = scoreToCP(playerLines[1].score);
            playerSecondMove = playerLines[1].pv[0];
          }
        } catch { /* ignore */ }

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
            bestScore: playerBestScore,
            bestMove: playerBestMove,
            secondBestScore: playerSecondScore,
            secondBestMove: playerSecondMove,
          },
        });
      }
    }
  }

  worker.terminate();
  return puzzles;
}

function analyzePosition(
  worker: Worker,
  fen: string,
  depth: number,
  multiPv: number,
): Promise<InfoLine[]> {
  return new Promise((resolve) => {
    const lines = new Map<number, InfoLine>();

    const handler = (e: MessageEvent) => {
      const msg = typeof e.data === 'string' ? e.data : '';

      if (msg.startsWith('info') && msg.includes(' pv ')) {
        const info = parseInfoLine(msg);
        if (info && info.depth >= depth - 2) {
          lines.set(info.multipv, info);
        }
      }

      if (msg.startsWith('bestmove')) {
        worker.removeEventListener('message', handler);
        const sorted = Array.from(lines.values()).sort((a, b) => a.multipv - b.multipv);
        resolve(sorted);
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
