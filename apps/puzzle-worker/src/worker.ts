import { ChildProcess, spawn } from 'child_process';
import { Chess } from 'chess.js';
import Redis from 'ioredis';

const QUEUE_KEY = 'puzzle-gen:queue';
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || '/usr/games/stockfish';
const ANALYSIS_DEPTH = parseInt(process.env.PUZZLE_DEPTH || '18', 10);
const MIN_EVAL_DROP = 200;
const MIN_SPREAD = 150;
const MIN_MOVE_NUM = 10;
const MAX_SOLUTION_MOVES = 6;
const MIN_TIME_CONTROL_SEC = 180;
const MIN_PLAYER_RATING = 1200;
const MIN_GAME_MOVES = 20;
const STOCKFISH_BOT_ID = '00000000-0000-4000-a000-000000000001';
const CACHE_TTL = 86400;

interface Score { type: 'cp' | 'mate'; value: number }
interface PVLine { pv: string; score: Score; bestMove: string }

export class PuzzleWorker {
  private redis!: Redis;
  private prisma: any; // PrismaClient — imported dynamically
  private engine: ChildProcess | null = null;
  private stopped = false;

  async start(): Promise<void> {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.redis = new Redis({ host: redisHost, port: redisPort });

    // Dynamic import for Prisma (ESM)
    const { PrismaClient } = await import('./generated/prisma/client.js');
    this.prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

    console.log(`[puzzle-worker] Starting... Redis=${redisHost}:${redisPort} depth=${ANALYSIS_DEPTH}`);
    console.log(`[puzzle-worker] Stockfish: ${STOCKFISH_PATH}`);

    this.spawnEngine();
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.engine?.kill();
    await this.redis.quit().catch(() => {});
    await this.prisma?.$disconnect();
    console.log('[puzzle-worker] Stopped');
  }

  private spawnEngine(): void {
    this.engine = spawn(STOCKFISH_PATH, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.engine.on('error', (e) => console.error(`[puzzle-worker] Stockfish error: ${e.message}`));
    this.engine.on('exit', (code) => {
      console.warn(`[puzzle-worker] Stockfish exited: ${code}`);
      if (!this.stopped) {
        console.log('[puzzle-worker] Restarting Stockfish...');
        this.spawnEngine();
      }
    });
    this.sendCmd('uci');
    console.log('[puzzle-worker] Stockfish spawned');
  }

  private sendCmd(cmd: string): void {
    this.engine?.stdin?.write(cmd + '\n');
  }

  private waitFor(pattern: string, timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.engine?.stdout?.off('data', onData);
        reject(new Error(`Stockfish timeout waiting for ${pattern}`));
      }, timeoutMs);

      const buffer: string[] = [];
      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          buffer.push(line);
          if (line.includes(pattern)) {
            clearTimeout(timer);
            this.engine?.stdout?.off('data', onData);
            resolve(buffer.join('\n'));
            return;
          }
        }
      };
      this.engine?.stdout?.on('data', onData);
    });
  }

  private async analyze(fen: string, depth: number): Promise<{ bestMove: string; score: Score }> {
    this.sendCmd('ucinewgame');
    this.sendCmd('isready');
    await this.waitFor('readyok');
    this.sendCmd('setoption name MultiPV value 1');
    this.sendCmd(`position fen ${fen}`);
    this.sendCmd(`go depth ${depth}`);
    const output = await this.waitFor('bestmove', depth * 3000 + 15000);

    let bestMove = '';
    let score: Score = { type: 'cp', value: 0 };

    for (const line of output.split('\n')) {
      const bm = line.match(/^bestmove (\S+)/);
      if (bm) bestMove = bm[1];
      const info = line.match(/^info depth (\d+) .* score (cp|mate) (-?\d+) .* pv (.+)/);
      if (info && parseInt(info[1]) === depth) {
        score = { type: info[2] as 'cp' | 'mate', value: parseInt(info[3]) };
      }
    }
    return { bestMove, score };
  }

  private async analyzeMultiPV(fen: string, depth: number, mpv: number): Promise<PVLine[]> {
    this.sendCmd('ucinewgame');
    this.sendCmd('isready');
    await this.waitFor('readyok');
    this.sendCmd(`setoption name MultiPV value ${mpv}`);
    this.sendCmd(`position fen ${fen}`);
    this.sendCmd(`go depth ${depth}`);
    const output = await this.waitFor('bestmove', depth * 3000 + 15000);

    const pvMap = new Map<number, PVLine>();
    for (const line of output.split('\n')) {
      const m = line.match(/^info depth (\d+) .* multipv (\d+) .* score (cp|mate) (-?\d+) .* pv (.+)/);
      if (m && parseInt(m[1]) === depth) {
        const idx = parseInt(m[2]);
        const pv = m[5].trim();
        pvMap.set(idx, {
          pv,
          score: { type: m[3] as 'cp' | 'mate', value: parseInt(m[4]) },
          bestMove: pv.split(' ')[0],
        });
      }
    }

    this.sendCmd('setoption name MultiPV value 1');
    return Array.from(pvMap.entries()).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }

  private scoreToCp(s: Score): number {
    return s.type === 'mate' ? (s.value > 0 ? 10000 : -10000) : s.value;
  }

  // --- Poll loop ---

  private async pollLoop(): Promise<void> {
    console.log('[puzzle-worker] Polling queue...');
    while (!this.stopped) {
      try {
        const result = await this.redis.brpop(QUEUE_KEY, 5);
        if (!result) continue;
        const msg = result[1];

        try {
          let res: { puzzlesCreated: number; positionsAnalyzed: number };
          // Detect message type: JSON with type=pgn or plain UUID
          if (msg.startsWith('{')) {
            const parsed = JSON.parse(msg);
            if (parsed.type === 'pgn' && parsed.pgn) {
              console.log(`[puzzle-worker] Processing PGN (${parsed.pgn.length} chars)`);
              res = await this.processPgn(parsed.pgn, parsed.whiteRating ?? 1500, parsed.blackRating ?? 1500);
            } else {
              console.warn(`[puzzle-worker] Unknown message type: ${parsed.type}`);
              continue;
            }
          } else {
            console.log(`[puzzle-worker] Processing game ${msg}`);
            res = await this.processGame(msg);
          }
          console.log(`[puzzle-worker] Result: ${res.puzzlesCreated} puzzles from ${res.positionsAnalyzed} positions`);
        } catch (e: any) {
          console.error(`[puzzle-worker] Processing failed: ${e.message}`);
        }
      } catch (e: any) {
        if (!this.stopped) console.error(`[puzzle-worker] Poll error: ${e.message}`);
      }
    }
  }

  private async processGame(gameId: string): Promise<{ puzzlesCreated: number; positionsAnalyzed: number }> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: {
        id: true, status: true, whiteId: true, blackId: true,
        timeInitialSec: true, timeIncrementSec: true,
        white: { select: { ratingBlitz: true, ratingRapid: true } },
        black: { select: { ratingBlitz: true, ratingRapid: true } },
      },
    });

    if (!game || game.status !== 'finished') return { puzzlesCreated: 0, positionsAnalyzed: 0 };
    if (game.whiteId === STOCKFISH_BOT_ID || game.blackId === STOCKFISH_BOT_ID) return { puzzlesCreated: 0, positionsAnalyzed: 0 };
    if (game.timeInitialSec < MIN_TIME_CONTROL_SEC) return { puzzlesCreated: 0, positionsAnalyzed: 0 };

    const whiteRating = game.white?.ratingBlitz ?? game.white?.ratingRapid ?? 0;
    const blackRating = game.black?.ratingBlitz ?? game.black?.ratingRapid ?? 0;
    if (whiteRating < MIN_PLAYER_RATING || blackRating < MIN_PLAYER_RATING) return { puzzlesCreated: 0, positionsAnalyzed: 0 };

    const moves = await this.prisma.move.findMany({
      where: { gameId },
      orderBy: { moveNumber: 'asc' },
      select: { uci: true, fenAfter: true },
    });
    if (moves.length < MIN_GAME_MOVES) return { puzzlesCreated: 0, positionsAnalyzed: 0 };

    // Reconstruct positions
    const chess = new Chess();
    const positions: Array<{ fenBefore: string; fenAfter: string; playedUci: string; moveNum: number }> = [];
    for (const move of moves) {
      const fenBefore = chess.fen();
      try {
        chess.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci.length > 4 ? move.uci[4] : undefined });
      } catch { break; }
      positions.push({ fenBefore, fenAfter: chess.fen(), playedUci: move.uci, moveNum: positions.length + 1 });
    }

    let analyzed = 0;
    let created = 0;
    const avgRating = Math.round((whiteRating + blackRating) / 2);
    const totalToAnalyze = positions.length - 2 - MIN_MOVE_NUM;
    console.log(`[puzzle-worker] Game: ${moves.length} moves, ${totalToAnalyze} positions to analyze`);

    for (let i = MIN_MOVE_NUM; i < positions.length - 2; i++) {
      const pos = positions[i];
      analyzed++;
      if (analyzed % 5 === 1) console.log(`[puzzle-worker] Analyzing position ${analyzed}/${totalToAnalyze} (move ${pos.moveNum})`);

      // Check cache
      const cacheKey = `pgen:${pos.fenBefore}`;
      const cached = await this.redis.get(cacheKey).catch(() => null);
      let bestMove: string, bestScore: number, playedScore: number;

      if (cached) {
        const c = JSON.parse(cached);
        bestMove = c.bestMove;
        bestScore = c.bestScore;
        playedScore = c.playedScores?.[pos.playedUci] ?? bestScore;
      } else {
        const analysis = await this.analyzeMultiPV(pos.fenBefore, ANALYSIS_DEPTH, 3);
        if (analysis.length < 1) continue;
        bestMove = analysis[0].bestMove;
        bestScore = this.scoreToCp(analysis[0].score);

        const playedPV = analysis.find((a) => a.bestMove === pos.playedUci);
        if (playedPV) {
          playedScore = this.scoreToCp(playedPV.score);
        } else {
          const pa = await this.analyze(pos.fenAfter, Math.min(ANALYSIS_DEPTH, 14));
          playedScore = -this.scoreToCp(pa.score);
        }

        await this.redis.set(cacheKey, JSON.stringify({ bestMove, bestScore, playedScores: { [pos.playedUci]: playedScore } }), 'EX', CACHE_TTL).catch(() => {});
      }

      const evalDrop = bestScore - playedScore;
      if (evalDrop < MIN_EVAL_DROP) continue;

      // Spread check
      const postAnalysis = await this.analyzeMultiPV(pos.fenAfter, ANALYSIS_DEPTH, 2);
      if (postAnalysis.length < 2) continue;
      const spread = Math.abs(this.scoreToCp(postAnalysis[0].score) - this.scoreToCp(postAnalysis[1].score));
      if (spread < MIN_SPREAD) continue;

      // Recapture filter
      const blunderTo = pos.playedUci.slice(2, 4);
      const solutionFirst = postAnalysis[0].bestMove;
      if (solutionFirst.slice(2, 4) === blunderTo) continue;

      // Build solution line
      const solutionMoves = await this.buildSolutionLine(pos.fenAfter, solutionFirst);
      const moveCount = solutionMoves.split(' ').length;
      if (moveCount < 2) continue;

      const rating = this.estimateRating(avgRating, evalDrop, moveCount);
      const themes = this.classifyThemes(pos.fenAfter, solutionMoves);

      await this.prisma.generatedPuzzle.create({
        data: {
          fen: pos.fenAfter,
          moves: solutionMoves,
          rating,
          gap: spread,
          themes: themes.join(' '),
          sourceType: 'game',
          sourceId: gameId,
          sourceMoveNum: pos.moveNum,
          depth: ANALYSIS_DEPTH,
        },
      });
      created++;
      console.log(`[puzzle-worker] Puzzle: move ${pos.moveNum} drop=${evalDrop}cp spread=${spread}cp solution=${solutionMoves}`);
    }

    return { puzzlesCreated: created, positionsAnalyzed: analyzed };
  }

  private async processPgn(
    pgn: string,
    whiteRating: number,
    blackRating: number,
  ): Promise<{ puzzlesCreated: number; positionsAnalyzed: number }> {
    // Strip comments { ... } and variations ( ... ) before parsing
    const cleanPgn = pgn.replace(/\{[^}]*\}/g, '').replace(/\([^)]*\)/g, '');
    const chess = new Chess();
    try {
      chess.loadPgn(cleanPgn);
    } catch (e: any) {
      console.error(`[puzzle-worker] Invalid PGN: ${e.message}`);
      return { puzzlesCreated: 0, positionsAnalyzed: 0 };
    }

    const history = chess.history({ verbose: true });
    if (history.length < MIN_GAME_MOVES) return { puzzlesCreated: 0, positionsAnalyzed: 0 };

    // Reconstruct positions from history
    const replay = new Chess();
    const positions: Array<{ fenBefore: string; fenAfter: string; playedUci: string; moveNum: number }> = [];
    for (const move of history) {
      const fenBefore = replay.fen();
      const uci = move.from + move.to + (move.promotion ?? '');
      replay.move(move);
      positions.push({ fenBefore, fenAfter: replay.fen(), playedUci: uci, moveNum: positions.length + 1 });
    }

    // Reuse analysis logic — same as processGame but with sourceType=pgn
    let analyzed = 0;
    let created = 0;
    const avgRating = Math.round((whiteRating + blackRating) / 2);

    const totalToAnalyze = positions.length - 2 - MIN_MOVE_NUM;
    console.log(`[puzzle-worker] PGN: ${history.length} moves, ${totalToAnalyze} positions to analyze`);

    for (let i = MIN_MOVE_NUM; i < positions.length - 2; i++) {
      const pos = positions[i];
      analyzed++;
      if (analyzed % 5 === 1) console.log(`[puzzle-worker] Analyzing position ${analyzed}/${totalToAnalyze} (move ${pos.moveNum})`);

      const cacheKey = `pgen:${pos.fenBefore}`;
      const cached = await this.redis.get(cacheKey).catch(() => null);
      let bestMove: string, bestScore: number, playedScore: number;

      if (cached) {
        const c = JSON.parse(cached);
        bestMove = c.bestMove;
        bestScore = c.bestScore;
        playedScore = c.playedScores?.[pos.playedUci] ?? bestScore;
      } else {
        const analysis = await this.analyzeMultiPV(pos.fenBefore, ANALYSIS_DEPTH, 3);
        if (analysis.length < 1) continue;
        bestMove = analysis[0].bestMove;
        bestScore = this.scoreToCp(analysis[0].score);

        const playedPV = analysis.find((a) => a.bestMove === pos.playedUci);
        if (playedPV) {
          playedScore = this.scoreToCp(playedPV.score);
        } else {
          const pa = await this.analyze(pos.fenAfter, Math.min(ANALYSIS_DEPTH, 14));
          playedScore = -this.scoreToCp(pa.score);
        }

        await this.redis.set(cacheKey, JSON.stringify({ bestMove, bestScore, playedScores: { [pos.playedUci]: playedScore } }), 'EX', CACHE_TTL).catch(() => {});
      }

      const evalDrop = bestScore - playedScore;
      if (evalDrop < MIN_EVAL_DROP) { console.log(`[puzzle-worker] move ${pos.moveNum}: skip evalDrop=${evalDrop}cp < ${MIN_EVAL_DROP}`); continue; }

      const postAnalysis = await this.analyzeMultiPV(pos.fenAfter, ANALYSIS_DEPTH, 2);
      if (postAnalysis.length < 2) { console.log(`[puzzle-worker] move ${pos.moveNum}: skip postAnalysis < 2 lines`); continue; }
      const spread = Math.abs(this.scoreToCp(postAnalysis[0].score) - this.scoreToCp(postAnalysis[1].score));
      if (spread < MIN_SPREAD) { console.log(`[puzzle-worker] move ${pos.moveNum}: skip spread=${spread}cp < ${MIN_SPREAD} (drop=${evalDrop}cp)`); continue; }

      const blunderTo = pos.playedUci.slice(2, 4);
      const solutionFirst = postAnalysis[0].bestMove;
      if (solutionFirst.slice(2, 4) === blunderTo) { console.log(`[puzzle-worker] move ${pos.moveNum}: skip recapture on ${blunderTo}`); continue; }

      const solutionMoves = await this.buildSolutionLine(pos.fenAfter, solutionFirst);
      const moveCount = solutionMoves.split(' ').length;
      if (moveCount < 2) { console.log(`[puzzle-worker] move ${pos.moveNum}: skip short solution (${moveCount} moves)`); continue; }

      const rating = this.estimateRating(avgRating, evalDrop, moveCount);
      const themes = this.classifyThemes(pos.fenAfter, solutionMoves);

      await this.prisma.generatedPuzzle.create({
        data: {
          fen: pos.fenAfter,
          moves: solutionMoves,
          rating,
          gap: spread,
          themes: themes.join(' '),
          sourceType: 'pgn',
          sourceMoveNum: pos.moveNum,
          depth: ANALYSIS_DEPTH,
        },
      });
      created++;
      console.log(`[puzzle-worker] PGN Puzzle: move ${pos.moveNum} drop=${evalDrop}cp spread=${spread}cp solution=${solutionMoves}`);
    }

    return { puzzlesCreated: created, positionsAnalyzed: analyzed };
  }

  private async buildSolutionLine(fen: string, firstMove: string): Promise<string> {
    const chess = new Chess(fen);
    const moves: string[] = [];
    try {
      chess.move({ from: firstMove.slice(0, 2), to: firstMove.slice(2, 4), promotion: firstMove.length > 4 ? firstMove[4] : undefined });
      moves.push(firstMove);

      for (let step = 1; step < MAX_SOLUTION_MOVES; step++) {
        if (chess.isGameOver()) break;
        const isSolver = step % 2 === 0;

        if (isSolver) {
          const mpv = await this.analyzeMultiPV(chess.fen(), Math.min(ANALYSIS_DEPTH, 14), 2);
          if (mpv.length < 1 || !mpv[0].bestMove || mpv[0].bestMove === '(none)') break;
          if (mpv.length >= 2 && Math.abs(this.scoreToCp(mpv[0].score) - this.scoreToCp(mpv[1].score)) < MIN_SPREAD) break;
          const bm = mpv[0].bestMove;
          chess.move({ from: bm.slice(0, 2), to: bm.slice(2, 4), promotion: bm.length > 4 ? bm[4] : undefined });
          moves.push(bm);
        } else {
          const a = await this.analyze(chess.fen(), Math.min(ANALYSIS_DEPTH, 14));
          if (!a.bestMove || a.bestMove === '(none)') break;
          chess.move({ from: a.bestMove.slice(0, 2), to: a.bestMove.slice(2, 4), promotion: a.bestMove.length > 4 ? a.bestMove[4] : undefined });
          moves.push(a.bestMove);
        }
      }
    } catch { /* invalid move */ }
    return moves.join(' ');
  }

  private classifyThemes(fen: string, solutionMoves: string): string[] {
    const themes: string[] = [];
    const moves = solutionMoves.split(' ');
    const chess = new Chess(fen);

    // Endgame: <= 7 total pieces (kings + others, excluding pawns is too complex for MVP)
    const pieces = fen.split(' ')[0].replace(/[0-9/]/g, '');
    if (pieces.length <= 7) themes.push('endgame');

    // Play through solution to check for mate
    try {
      for (const uci of moves) {
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
      }
      if (chess.isCheckmate()) {
        // Count solver's moves (indices 0, 2, 4...) = ceil(moves.length / 2)
        const solverMoves = Math.ceil(moves.length / 2);
        if (solverMoves <= 3) themes.push(`mateIn${solverMoves}`);
        themes.push('mate');
      }
    } catch { /* invalid move sequence */ }

    // Fork: first solution move attacks >= 2 pieces (including king)
    try {
      const forkChess = new Chess(fen);
      const firstUci = moves[0];
      forkChess.move({ from: firstUci.slice(0, 2), to: firstUci.slice(2, 4), promotion: firstUci.length > 4 ? firstUci[4] : undefined });
      const to = firstUci.slice(2, 4);
      // Get all squares attacked by the piece that just moved
      const attackedPieces: string[] = [];
      const board = forkChess.board();
      const movingColor = fen.split(' ')[1] === 'w' ? 'b' : 'w'; // after move, it's opponent's turn; piece that moved is opposite
      const pieceColor = movingColor === 'w' ? 'b' : 'w'; // the solver's color

      // Check all opponent pieces — are they attacked by the piece on 'to'?
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const sq = board[r][c];
          if (!sq || sq.color === pieceColor) continue; // skip own pieces
          const sqName = String.fromCharCode(97 + c) + (8 - r);
          if (sqName === to) continue;
          // Check if piece on 'to' attacks this square
          const testChess = new Chess(forkChess.fen());
          // Remove the opponent piece and see if our piece can move there
          // Simpler: check if there's a legal move from 'to' to 'sqName' (capture)
          const legalMoves = testChess.moves({ square: to as any, verbose: true });
          if (legalMoves.some((m: any) => m.to === sqName)) {
            attackedPieces.push(sq.type);
          }
        }
      }
      if (attackedPieces.length >= 2) themes.push('fork');
    } catch { /* ignore */ }

    return themes;
  }

  private estimateRating(avgPlayerRating: number, evalDrop: number, solutionLength: number): number {
    let rating = avgPlayerRating;
    rating += (solutionLength - 4) * 100;
    if (evalDrop >= 500) rating -= 100;
    else if (evalDrop < 300) rating += 100;
    return Math.max(600, Math.min(2500, rating));
  }
}
