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
  bestScore?: number;
  bestMove?: string;
  secondBestScore?: number;
  secondBestMove?: string;
};

export type GeneratedPuzzleData = {
  fen: string;
  moves: string; // space-separated UCI moves
  acceptedMoves?: string; // space-separated UCI moves (multiple correct answers)
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

export async function generatePuzzlesFromPgn(
  pgn: string,
  onProgress: (progress: GenerationProgress) => void,
  options: Partial<PuzzleGenSettings> & { abortSignal?: AbortSignal; bridgeConfig?: BridgeConfig } = {},
): Promise<GeneratedPuzzleData[]> {
  const settings = { ...DEFAULT_PUZZLE_GEN_SETTINGS, ...options };
  const { depth, gapThreshold, maxSecondCp, skipHangingCapture, skipAttackedByLesser, skipUndefendedAfterMove, acceptedMoves } = settings;
  // Ensure multiPv is at least acceptedMoves + 1 (need gap after N-th move)
  const effectiveMultiPv = Math.max(settings.multiPv, acceptedMoves + 1);
  const { abortSignal, bridgeConfig } = options;

  // Parse PGN into individual games
  const games = splitPgnIntoGames(pgn);
  console.log('[PuzzleGen] PGN split into', games.length, 'games, input length:', pgn.length);
  const puzzles: GeneratedPuzzleData[] = [];

  // Create engine adapter
  let engine: EngineAdapter;
  if (bridgeConfig) {
    engine = new BridgeEngineAdapter(bridgeConfig);
  } else {
    engine = new WasmEngineAdapter();
  }

  await engine.init();

  engine.setOption('MultiPV', String(effectiveMultiPv));
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
    console.log('[PuzzleGen] Game', gi + 1, ':', moves.length, 'moves');
    const positions: { fen: string; moveNum: number }[] = [];
    // Use FEN from PGN header if present, otherwise standard start
    const fenMatch = gamePgn.match(/\[FEN\s+"([^"]+)"\]/);
    const startFen = fenMatch ? fenMatch[1] : undefined;
    const replay = startFen ? new Chess(startFen) : new Chess();
    for (let i = 0; i < moves.length; i++) {
      positions.push({ fen: replay.fen(), moveNum: i + 1 });
      replay.move(moves[i].san);
    }

    const SKIP_OPENING = 20; // skip first 10 moves (20 half-moves)
    for (let pi = SKIP_OPENING; pi < positions.length; pi++) {
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
        if (check.isGameOver()) { console.log(`[PuzzleGen] pos=${pi} SKIP: gameOver`); continue; }
        const legalMoves = check.moves().length;
        if (legalMoves <= 1) { console.log(`[PuzzleGen] pos=${pi} SKIP: legalMoves=${legalMoves}`); continue; }
      } catch (e) {
        console.warn('[PuzzleGen] pos=', pi, 'SKIP: fen check error:', e instanceof Error ? e.message : e);
        continue;
      }

      // Single analysis with depth history tracking
      let analysis: Awaited<ReturnType<EngineAdapter['analyze']>>;
      try {
        analysis = await engine.analyze(fen, depth, effectiveMultiPv);
      } catch (e) {
        console.error('[PuzzleGen] Engine analyze error at pos', pi, ':', e);
        continue;
      }
      if (analysis.lines.length === 0) continue;

      const best = analysis.lines[0];
      const bestMoveUci = best.pv[0];

      const bestCp = scoreToCP(best.score);
      // For acceptedMoves=N, gap is between N-th and (N+1)-th line
      const N = acceptedMoves;
      const nthCp = analysis.lines.length > N - 1 ? scoreToCP(analysis.lines[N - 1].score) : bestCp;
      const nextCp = analysis.lines.length > N ? scoreToCP(analysis.lines[N].score) : 0;
      const gap = analysis.lines.length > N ? Math.abs(nthCp - nextCp) : (best.score.type === 'mate' ? 10000 : 0);
      // topSpread: difference between 1st and N-th move (must be small for multiple accepted)
      const topSpread = Math.abs(bestCp - nthCp);
      const TOP_SPREAD_THRESHOLD = 30;
      const secondCp = analysis.lines.length >= 2 ? scoreToCP(analysis.lines[1].score) : 0;

      // Eval growth: compare eval at depth 1 vs depth 14
      const evalAtShallow = analysis.evalByDepth.get(1) ?? analysis.evalByDepth.get(2) ?? bestCp;
      const evalAtDeep = bestCp;
      const evalGrowth = evalAtDeep - evalAtShallow;
      // KS-2034: EVAL_GROWTH_THRESHOLD удалён — нигде не сравнивался,
      // только лог `growth=...` использовал `evalGrowth`. Если вернутся
      // условия по eval-growth — добавлять явно с использованием.

      // Analyze bestMove properties
      let isHangingCapture = false;
      let attackedByLesser = false;
      let undefendedAfterMove = false;
      if (best.pv.length >= 1) {
        try {
          const testChess = new Chess(fen);
          const from = best.pv[0].slice(0, 2);
          const to = best.pv[0].slice(2, 4);
          const movedPiece = testChess.get(from as Parameters<typeof testChess.get>[0]);
          const movedValue = movedPiece ? (PIECE_VALUE[movedPiece.type] || 0) : 0;
          const moveObj = testChess.move({ from, to, promotion: best.pv[0][4] });

          if (moveObj) {
            // Hanging capture: captured piece and no recapture possible
            if (moveObj.captured) {
              const recaptures = testChess.moves({ verbose: true }).filter(m => m.to === moveObj.to && m.captured);
              if (recaptures.length === 0) isHangingCapture = true;
            }

            // Attacked by lesser: after move, piece on target attacked by cheaper piece
            const opponent = moveObj.color === 'w' ? 'b' : 'w';
            if (testChess.isAttacked(to as Parameters<typeof testChess.isAttacked>[0], opponent)) {
              const attackerMoves = testChess.moves({ verbose: true }).filter(m => m.to === to);
              const cheapestAttacker = Math.min(...attackerMoves.map(m => PIECE_VALUE[m.piece] || 0));
              if (cheapestAttacker < movedValue) attackedByLesser = true;

              // Undefended: attacked but not defended by own pieces
              testChess.undo();
              testChess.move(moveObj.san); // replay to check own defense
              // Swap turn to check if own side defends
              // chess.js doesn't have "isDefended" — approximate: undo, check if own piece attacks the square
              // (`ownColor = moveObj.color` удалён — переменная не использовалась).
              const preMove = new Chess(fen);
              // Check if any own piece (other than the moved one) attacks the target square
              const ownAttacks = preMove.moves({ verbose: true }).filter(m => m.to === to && m.from !== from);
              if (ownAttacks.length === 0) undefendedAfterMove = true;
            }

            testChess.undo();
          }
        } catch { /* ignore */ }
      }

      const isMate = best.score.type === 'mate';
      const mateDist = isMate ? Math.abs(best.score.value) : 0;
      const logBase = `[PuzzleGen] pos=${pi} bestMove=${bestMoveUci} evalShallow=${evalAtShallow} evalDeep=${evalAtDeep} growth=${evalGrowth} gap=${gap}`;

      // Apply filters with explicit skip reason
      if (skipHangingCapture && isHangingCapture) {
        console.log(`${logBase} SKIP:hangingCapture`); continue;
      }
      if (skipAttackedByLesser && attackedByLesser) {
        console.log(`${logBase} SKIP:attackedByLesser`); continue;
      }
      if (skipUndefendedAfterMove && undefendedAfterMove) {
        console.log(`${logBase} SKIP:undefendedAfterMove`); continue;
      }
      if (analysis.lines.length >= 2 && Math.abs(secondCp) > maxSecondCp) {
        console.log(`${logBase} SKIP:|secondCp|=${Math.abs(secondCp)}>${maxSecondCp}`); continue;
      }
      if (gap < gapThreshold) {
        console.log(`${logBase} SKIP:gap<${gapThreshold}`); continue;
      }
      if (N > 1 && topSpread > TOP_SPREAD_THRESHOLD) {
        console.log(`${logBase} SKIP:topSpread=${topSpread}>${TOP_SPREAD_THRESHOLD}`); continue;
      }
      if (best.pv.length < (isMate ? 1 : 2)) {
        console.log(`${logBase} SKIP:pv.length=${best.pv.length}<${isMate ? 1 : 2}`); continue;
      }

      {
        const themes = classifyThemes(gap, best.pv, fen, isMate, mateDist);
        const rating = estimateRating(fen, [best.pv[0]], isMate, mateDist);
        console.log(`${logBase} ACCEPTED rating=${rating}`);

        // Use scores from THIS position's analysis (same side moves)
        const secondLine = analysis.lines.length >= 2 ? analysis.lines[1] : null;

        // Collect accepted moves (top N lines' first moves)
        const acceptedMovesList = analysis.lines.slice(0, N).map((l) => l.pv[0]).filter(Boolean);

        puzzles.push({
          fen,
          moves: best.pv.slice(0, 8).join(' '),
          acceptedMoves: acceptedMovesList.length > 1 ? acceptedMovesList.join(' ') : undefined,
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

  engine.destroy();
  console.log('[PuzzleGen] Done. Total puzzles:', puzzles.length);
  return puzzles;
}


/** Strip comments {…}, variations (…), NAG ($1 etc), extra whitespace from PGN movetext */
function stripPgnAnnotations(pgn: string): string {
  // Preserve header lines, only strip from movetext
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
