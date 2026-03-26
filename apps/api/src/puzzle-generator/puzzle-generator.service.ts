import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Chess } from 'chess.js';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StockfishService } from '../engine/stockfish.service';

interface PuzzleCandidate {
  fen: string;
  moves: string;   // solution moves separated by space (UCI)
  gap: number;      // cp gap between best and 2nd best
  rating: number;
  sourceMoveNum: number;
}

const CACHE_TTL = 86400; // 24h
const MIN_GAP = 150;     // minimum cp gap to qualify as puzzle

@Injectable()
export class PuzzleGeneratorService {
  private readonly logger = new Logger(PuzzleGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly stockfish: StockfishService,
  ) {}

  /**
   * Generate puzzles from a game. Analyzes each position with MultiPV
   * and finds positions where there is a large gap between best and 2nd best move.
   */
  async generateFromGame(
    gameId: string,
    userId?: string,
    depth = 18,
  ): Promise<{ puzzlesCreated: number; positionsAnalyzed: number }> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true, status: true },
    });

    if (!game || game.status !== 'finished') {
      throw new NotFoundException('Game not found or not finished');
    }

    const moves = await this.prisma.move.findMany({
      where: { gameId },
      orderBy: { moveNumber: 'asc' },
      select: { uci: true, san: true, fenAfter: true },
    });

    if (moves.length < 6) {
      return { puzzlesCreated: 0, positionsAnalyzed: 0 };
    }

    const candidates: PuzzleCandidate[] = [];

    // Analyze positions starting from move 4 (skip opening)
    for (let i = 3; i < moves.length - 2; i++) {
      const fen = moves[i].fenAfter;

      // Check Redis cache first
      const cached = await this.getCachedAnalysis(fen);
      let gap: number;
      let bestMove: string;
      let secondBestMove: string | undefined;

      if (cached) {
        gap = cached.gap;
        bestMove = cached.bestMove;
        secondBestMove = cached.secondBestMove;
      } else {
        const analysis = await this.stockfish.analyzeMultiPV(fen, depth, 3);
        if (analysis.length < 2) continue;

        const bestScore = this.scoreToCp(analysis[0].score);
        const secondScore = this.scoreToCp(analysis[1].score);
        gap = Math.abs(bestScore - secondScore);
        bestMove = analysis[0].bestMove;
        secondBestMove = analysis[1].bestMove;

        // Cache result
        await this.cacheAnalysis(fen, { gap, bestMove, secondBestMove });
      }

      if (gap >= MIN_GAP) {
        // Build solution line: best move + opponent response + best move...
        const solutionMoves = await this.buildSolutionLine(fen, bestMove, depth);
        const rating = this.estimateRating(gap);

        candidates.push({
          fen,
          moves: solutionMoves,
          gap,
          rating,
          sourceMoveNum: i + 1,
        });
      }
    }

    // Save candidates to DB
    let created = 0;
    for (const c of candidates) {
      await this.prisma.generatedPuzzle.create({
        data: {
          fen: c.fen,
          moves: c.moves,
          rating: c.rating,
          gap: c.gap,
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
      `Generated ${created} puzzles from game ${gameId} (${moves.length} positions analyzed)`,
    );

    return { puzzlesCreated: created, positionsAnalyzed: moves.length - 5 };
  }

  /**
   * Build a solution line: best move, then opponent's best response, then best move...
   * Returns UCI moves separated by space.
   */
  private async buildSolutionLine(
    fen: string,
    firstMove: string,
    depth: number,
  ): Promise<string> {
    const chess = new Chess(fen);
    const solutionMoves: string[] = [];

    try {
      // First move (the "setup" move that creates the puzzle)
      const from = firstMove.slice(0, 2);
      const to = firstMove.slice(2, 4);
      const promo = firstMove.length > 4 ? firstMove[4] : undefined;
      chess.move({ from, to, promotion: promo });
      solutionMoves.push(firstMove);

      // Up to 3 more half-moves (opponent response + solution + opponent response)
      for (let step = 0; step < 3; step++) {
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
   * Estimate puzzle rating from cp gap.
   * Larger gap = easier puzzle = lower rating.
   */
  private estimateRating(gap: number): number {
    if (gap >= 500) return 800 + Math.floor(Math.random() * 400);
    if (gap >= 300) return 1200 + Math.floor(Math.random() * 400);
    if (gap >= 200) return 1600 + Math.floor(Math.random() * 300);
    return 1900 + Math.floor(Math.random() * 300);
  }

  private scoreToCp(score: { type: 'cp' | 'mate'; value: number }): number {
    if (score.type === 'mate') {
      return score.value > 0 ? 10000 : -10000;
    }
    return score.value;
  }

  private async getCachedAnalysis(
    fen: string,
  ): Promise<{ gap: number; bestMove: string; secondBestMove?: string } | null> {
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
    data: { gap: number; bestMove: string; secondBestMove?: string },
  ): Promise<void> {
    const key = `pgen:${fen}`;
    await this.redis.set(key, JSON.stringify(data), 'EX', CACHE_TTL);
  }
}
