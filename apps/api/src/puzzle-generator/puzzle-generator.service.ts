import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Chess } from 'chess.js';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StockfishService } from '../engine/stockfish.service';
import { STOCKFISH_BOT_ID } from '@kingside/shared';

interface PuzzleCandidate {
  fen: string;         // position AFTER the blunder (puzzle start)
  setupMove: string;   // the blunder move (shown to player before puzzle)
  moves: string;       // solution moves separated by space (UCI)
  evalDrop: number;    // cp drop from best to played move
  spread: number;      // cp gap between best and 2nd best in solution position
  rating: number;
  sourceMoveNum: number;
}

const CACHE_TTL = 86400; // 24h
const MIN_EVAL_DROP = 200;  // minimum cp drop to detect blunder
const MIN_SPREAD = 150;     // minimum spread for unique solution
const MIN_MOVE_NUM = 10;    // skip opening (first 10 half-moves)
const MAX_SOLUTION_MOVES = 6; // max half-moves in solution line
const MIN_TIME_CONTROL_SEC = 180; // minimum time control (3+0)
const MIN_PLAYER_RATING = 1200;   // minimum rating for both players
const MIN_GAME_MOVES = 20;        // minimum half-moves in game

@Injectable()
export class PuzzleGeneratorService {
  private readonly logger = new Logger(PuzzleGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly stockfish: StockfishService,
  ) {}

  /**
   * Generate puzzles from a game using blunder detection.
   * 1. For each position, compare played move vs best move (eval drop >= 200cp)
   * 2. In position after blunder, check spread >= 150cp (unique solution)
   * 3. Build solution line from the post-blunder position
   */
  async generateFromGame(
    gameId: string,
    userId?: string,
    depth = 18,
  ): Promise<{ puzzlesCreated: number; positionsAnalyzed: number }> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: {
        id: true, status: true, whiteId: true, blackId: true,
        timeInitialSec: true, timeIncrementSec: true,
        white: { select: { ratingBlitz: true, ratingRapid: true } },
        black: { select: { ratingBlitz: true, ratingRapid: true } },
      },
    });

    if (!game || game.status !== 'finished') {
      throw new NotFoundException('Game not found or not finished');
    }

    // Filter: no bot games
    if (game.whiteId === STOCKFISH_BOT_ID || game.blackId === STOCKFISH_BOT_ID) {
      throw new BadRequestException('Bot games are not eligible for puzzle generation');
    }

    // Filter: time control >= 3+0
    if (game.timeInitialSec < MIN_TIME_CONTROL_SEC) {
      throw new BadRequestException(`Time control too fast: ${game.timeInitialSec}s (min ${MIN_TIME_CONTROL_SEC}s)`);
    }

    // Filter: both players rated >= 1200
    const whiteRating = game.white?.ratingBlitz ?? game.white?.ratingRapid ?? 0;
    const blackRating = game.black?.ratingBlitz ?? game.black?.ratingRapid ?? 0;
    if (whiteRating < MIN_PLAYER_RATING || blackRating < MIN_PLAYER_RATING) {
      throw new BadRequestException(`Player rating too low: white=${whiteRating} black=${blackRating} (min ${MIN_PLAYER_RATING})`);
    }

    const moves = await this.prisma.move.findMany({
      where: { gameId },
      orderBy: { moveNumber: 'asc' },
      select: { uci: true, san: true, fenAfter: true },
    });

    // Filter: minimum game length
    if (moves.length < MIN_GAME_MOVES) {
      return { puzzlesCreated: 0, positionsAnalyzed: 0 };
    }

    // Reconstruct FEN before each move
    const chess = new Chess();
    const positions: Array<{ fenBefore: string; fenAfter: string; playedUci: string; moveNum: number }> = [];
    for (const move of moves) {
      const fenBefore = chess.fen();
      const from = move.uci.slice(0, 2);
      const to = move.uci.slice(2, 4);
      const promo = move.uci.length > 4 ? move.uci[4] : undefined;
      try {
        chess.move({ from, to, promotion: promo });
      } catch {
        break; // invalid move — stop
      }
      positions.push({ fenBefore, fenAfter: chess.fen(), playedUci: move.uci, moveNum: positions.length + 1 });
    }

    const candidates: PuzzleCandidate[] = [];
    let analyzed = 0;

    // Analyze positions starting from MIN_MOVE_NUM, stop 2 before end
    for (let i = MIN_MOVE_NUM; i < positions.length - 2; i++) {
      const pos = positions[i];
      analyzed++;

      // Step 1: Analyze position BEFORE the move (MultiPV=2)
      const cached = await this.getCachedAnalysis(pos.fenBefore);
      let bestMove: string;
      let bestScore: number;
      let playedScore: number;

      if (cached) {
        bestMove = cached.bestMove;
        bestScore = cached.bestScore;
        playedScore = cached.playedScores?.[pos.playedUci] ?? bestScore;
      } else {
        const analysis = await this.stockfish.analyzeMultiPV(pos.fenBefore, depth, 3);
        if (analysis.length < 1) continue;

        bestMove = analysis[0].bestMove;
        bestScore = this.scoreToCp(analysis[0].score);

        // Find score of the played move among PV lines
        const playedPV = analysis.find((a) => a.bestMove === pos.playedUci);
        if (playedPV) {
          playedScore = this.scoreToCp(playedPV.score);
        } else {
          // Played move not in top 3 — analyze it separately
          const playedAnalysis = await this.stockfish.analyze(pos.fenAfter, Math.min(depth, 14));
          // Score from opponent's perspective → negate
          playedScore = -this.scoreToCp(playedAnalysis.score);
        }

        await this.cacheAnalysis(pos.fenBefore, { bestMove, bestScore, playedScores: { [pos.playedUci]: playedScore } });
      }

      // Step 2: Detect blunder — eval drop from side-to-move perspective
      const evalDrop = bestScore - playedScore;
      if (evalDrop < MIN_EVAL_DROP) continue;

      // Step 3: In position AFTER blunder, check spread (unique solution)
      const postBlunderAnalysis = await this.stockfish.analyzeMultiPV(pos.fenAfter, depth, 2);
      if (postBlunderAnalysis.length < 2) continue;

      const solutionBest = this.scoreToCp(postBlunderAnalysis[0].score);
      const solutionSecond = this.scoreToCp(postBlunderAnalysis[1].score);
      const spread = Math.abs(solutionBest - solutionSecond);
      if (spread < MIN_SPREAD) continue;

      // Filter: skip if solution is a simple recapture (same target square as blunder)
      const blunderTo = pos.playedUci.slice(2, 4);
      const solutionFirstMove = postBlunderAnalysis[0].bestMove;
      const solutionTo = solutionFirstMove.slice(2, 4);
      if (blunderTo === solutionTo) continue; // recapture — not interesting

      // Step 4: Build solution line from post-blunder position
      const solutionMoves = await this.buildSolutionLine(pos.fenAfter, solutionFirstMove, depth);
      if (solutionMoves.split(' ').length < 1) continue;

      const rating = this.estimateRating(evalDrop, spread, solutionMoves.split(' ').length);

      candidates.push({
        fen: pos.fenAfter,
        setupMove: pos.playedUci,
        moves: solutionMoves,
        evalDrop,
        spread,
        rating,
        sourceMoveNum: pos.moveNum,
      });

      this.logger.log(
        `Blunder found: move ${pos.moveNum} ${pos.playedUci} drop=${evalDrop}cp spread=${spread}cp solution=${solutionMoves}`,
      );
    }

    // Save candidates to DB
    let created = 0;
    for (const c of candidates) {
      await this.prisma.generatedPuzzle.create({
        data: {
          fen: c.fen,
          moves: c.moves,
          rating: c.rating,
          gap: c.spread,
          sourceType: 'game',
          sourceId: gameId,
          sourceMoveNum: c.sourceMoveNum,
          depth,
          createdBy: userId,
        },
      });
      created++;
    }

    this.logger.log(
      `Generated ${created} puzzles from game ${gameId} (${analyzed} positions analyzed, ${candidates.length} blunders found)`,
    );

    return { puzzlesCreated: created, positionsAnalyzed: analyzed };
  }

  /**
   * Build a solution line from the post-blunder position.
   * Each move must be the unique best (large spread over 2nd best).
   */
  private async buildSolutionLine(
    fen: string,
    firstMove: string,
    depth: number,
  ): Promise<string> {
    const chess = new Chess(fen);
    const solutionMoves: string[] = [];

    try {
      const from = firstMove.slice(0, 2);
      const to = firstMove.slice(2, 4);
      const promo = firstMove.length > 4 ? firstMove[4] : undefined;
      chess.move({ from, to, promotion: promo });
      solutionMoves.push(firstMove);

      for (let step = 0; step < MAX_SOLUTION_MOVES - 1; step++) {
        const currentFen = chess.fen();
        if (chess.isGameOver()) break;

        const analysis = await this.stockfish.analyze(currentFen, Math.min(depth, 14));
        if (!analysis.bestMove || analysis.bestMove === '(none)') break;

        const bm = analysis.bestMove;
        const f = bm.slice(0, 2);
        const t = bm.slice(2, 4);
        const p = bm.length > 4 ? bm[4] : undefined;
        chess.move({ from: f, to: t, promotion: p });
        solutionMoves.push(bm);
      }
    } catch {
      // Invalid move — return what we have
    }

    return solutionMoves.join(' ');
  }

  /**
   * Estimate puzzle rating from eval drop, spread, and solution length.
   * Larger drop = easier to spot = lower rating.
   * Longer solution = harder = higher rating.
   */
  private estimateRating(evalDrop: number, spread: number, solutionLength: number): number {
    let base: number;
    if (evalDrop >= 500) base = 800;
    else if (evalDrop >= 300) base = 1200;
    else base = 1600;

    // Longer solutions are harder
    base += (solutionLength - 1) * 100;

    // Add randomness
    base += Math.floor(Math.random() * 200) - 100;

    return Math.max(600, Math.min(2500, base));
  }

  private scoreToCp(score: { type: 'cp' | 'mate'; value: number }): number {
    if (score.type === 'mate') {
      return score.value > 0 ? 10000 : -10000;
    }
    return score.value;
  }

  private async getCachedAnalysis(
    fen: string,
  ): Promise<{ bestMove: string; bestScore: number; playedScores?: Record<string, number> } | null> {
    const key = `pgen:${fen}`;
    const data = await this.redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async cacheAnalysis(
    fen: string,
    data: { bestMove: string; bestScore: number; playedScores?: Record<string, number> },
  ): Promise<void> {
    const key = `pgen:${fen}`;
    await this.redis.set(key, JSON.stringify(data), 'EX', CACHE_TTL);
  }
}
