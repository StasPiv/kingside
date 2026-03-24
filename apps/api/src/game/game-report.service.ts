import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { Chess } from 'chess.js';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../engine/stockfish.service';

export type MoveClassification = 'brilliant' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'book';

export interface MoveAnalysis {
  moveNumber: number;
  color: 'white' | 'black';
  san: string;
  uci: string;
  evalBefore: { type: 'cp' | 'mate'; value: number } | null;
  evalAfter: { type: 'cp' | 'mate'; value: number } | null;
  bestMove: string | null;
  cpLoss: number;
  classification: MoveClassification;
}

export interface GameReportResult {
  id: string;
  gameId: string;
  whiteAccuracy: number;
  blackAccuracy: number;
  moves: MoveAnalysis[];
  status: string;
}

/** Classify move by centipawn loss */
function classifyMove(cpLoss: number): MoveClassification {
  if (cpLoss <= 0) return 'best';
  if (cpLoss <= 10) return 'good';
  if (cpLoss <= 50) return 'inaccuracy';
  if (cpLoss <= 150) return 'mistake';
  return 'blunder';
}

/** Convert eval to centipawns (mate = ±10000) for loss calculation */
function evalToCp(ev: { type: 'cp' | 'mate'; value: number }): number {
  if (ev.type === 'mate') {
    return ev.value > 0 ? 10000 - ev.value * 10 : -10000 - ev.value * 10;
  }
  return ev.value;
}

/**
 * Calculate accuracy from centipawn loss using a formula similar to chess.com.
 * accuracy = 103.1668 * exp(-0.04354 * cpLoss) - 3.1668
 * Clamped to [0, 100].
 */
function accuracyFromCpLoss(avgCpLoss: number): number {
  const raw = 103.1668 * Math.exp(-0.04354 * avgCpLoss) - 3.1668;
  return Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
}

const ANALYSIS_DEPTH = 18;

@Injectable()
export class GameReportService {
  private readonly logger = new Logger(GameReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockfish: StockfishService,
  ) {}

  async getReport(gameId: string): Promise<GameReportResult | null> {
    const report = await this.prisma.gameReport.findUnique({
      where: { gameId },
    });
    if (!report) return null;

    return {
      id: report.id,
      gameId: report.gameId,
      whiteAccuracy: report.whiteAccuracy,
      blackAccuracy: report.blackAccuracy,
      moves: JSON.parse(report.moves),
      status: report.status,
    };
  }

  async analyze(gameId: string): Promise<GameReportResult> {
    // Check if already analyzed
    const existing = await this.prisma.gameReport.findUnique({ where: { gameId } });
    if (existing && existing.status === 'complete') {
      return {
        id: existing.id,
        gameId: existing.gameId,
        whiteAccuracy: existing.whiteAccuracy,
        blackAccuracy: existing.blackAccuracy,
        moves: JSON.parse(existing.moves),
        status: existing.status,
      };
    }

    // Get game with moves
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: {
        id: true,
        status: true,
        moves: { orderBy: { moveNumber: 'asc' }, select: { uci: true, san: true, color: true, moveNumber: true, fenAfter: true } },
      },
    });

    if (!game) throw new NotFoundException('Game not found');
    if (game.status !== 'finished') throw new ConflictException('Can only analyze finished games');
    if (game.moves.length === 0) throw new ConflictException('Game has no moves');

    // Create or update report as "analyzing"
    const report = existing
      ? await this.prisma.gameReport.update({
          where: { gameId },
          data: { status: 'analyzing', whiteAccuracy: 0, blackAccuracy: 0, moves: '[]' },
        })
      : await this.prisma.gameReport.create({
          data: { gameId, status: 'analyzing', whiteAccuracy: 0, blackAccuracy: 0, moves: '[]', depth: ANALYSIS_DEPTH },
        });

    try {
      const moveAnalyses: MoveAnalysis[] = [];

      // Replay game and evaluate each position
      const chess = new Chess();
      let prevEval: { type: 'cp' | 'mate'; value: number } | null = null;

      // Evaluate starting position
      const startResult = await this.stockfish.analyze(chess.fen(), ANALYSIS_DEPTH);
      if (startResult.score) {
        prevEval = startResult.score;
      }

      for (const move of game.moves) {
        const isWhite = move.color === 'white';

        // Make the move
        chess.move(move.san);

        // Evaluate position after move
        let evalAfter: { type: 'cp' | 'mate'; value: number } | null = null;
        let bestMoveUci: string | null = null;

        if (!chess.isGameOver()) {
          const result = await this.stockfish.analyze(chess.fen(), ANALYSIS_DEPTH);
          if (result.score) {
            evalAfter = result.score;
          }
          bestMoveUci = result.bestMove !== '(none)' ? result.bestMove : null;
        } else {
          // Game over — assign definitive eval
          if (chess.isCheckmate()) {
            evalAfter = { type: 'mate', value: 0 };
          } else {
            evalAfter = { type: 'cp', value: 0 }; // draw
          }
        }

        // Calculate cp loss from the player's perspective
        let cpLoss = 0;
        if (prevEval && evalAfter) {
          const prevCp = evalToCp(prevEval);
          const afterCp = evalToCp(evalAfter);
          // evalAfter is from perspective of side to move AFTER the move (opponent)
          // So from the mover's perspective: loss = prevCp - (-afterCp) = prevCp + afterCp (if white)
          if (isWhite) {
            cpLoss = Math.max(0, prevCp - (-afterCp));
          } else {
            cpLoss = Math.max(0, (-prevCp) - afterCp);
          }
        }

        const classification = classifyMove(cpLoss);

        moveAnalyses.push({
          moveNumber: move.moveNumber,
          color: move.color as 'white' | 'black',
          san: move.san,
          uci: move.uci,
          evalBefore: prevEval,
          evalAfter: evalAfter,
          bestMove: bestMoveUci,
          cpLoss: Math.round(cpLoss),
          classification,
        });

        // Update prevEval for next iteration (from side-to-move perspective)
        prevEval = evalAfter;
      }

      // Calculate accuracy
      const whiteMoves = moveAnalyses.filter((m) => m.color === 'white');
      const blackMoves = moveAnalyses.filter((m) => m.color === 'black');

      const whiteAvgLoss = whiteMoves.length > 0
        ? whiteMoves.reduce((sum, m) => sum + m.cpLoss, 0) / whiteMoves.length
        : 0;
      const blackAvgLoss = blackMoves.length > 0
        ? blackMoves.reduce((sum, m) => sum + m.cpLoss, 0) / blackMoves.length
        : 0;

      const whiteAccuracy = accuracyFromCpLoss(whiteAvgLoss);
      const blackAccuracy = accuracyFromCpLoss(blackAvgLoss);

      // Save result
      const updated = await this.prisma.gameReport.update({
        where: { gameId },
        data: {
          status: 'complete',
          whiteAccuracy,
          blackAccuracy,
          moves: JSON.stringify(moveAnalyses),
        },
      });

      this.logger.log(`Game ${gameId} analyzed: white=${whiteAccuracy}%, black=${blackAccuracy}%, ${moveAnalyses.length} moves`);

      return {
        id: updated.id,
        gameId: updated.gameId,
        whiteAccuracy,
        blackAccuracy,
        moves: moveAnalyses,
        status: 'complete',
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Analysis failed for game ${gameId}: ${msg}`);
      await this.prisma.gameReport.update({
        where: { gameId },
        data: { status: 'error' },
      });
      throw e;
    }
  }
}
