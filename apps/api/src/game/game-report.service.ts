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

const MAX_CP_LOSS = 1000;

/**
 * Convert Stockfish eval (side-to-move perspective) to White's perspective in centipawns.
 * Stockfish always reports score from the side-to-move viewpoint.
 * sideToMove: who is about to move in the position that was evaluated.
 */
function evalToWhiteCp(
  ev: { type: 'cp' | 'mate'; value: number },
  sideToMove: 'white' | 'black',
): number {
  let cp: number;
  if (ev.type === 'mate') {
    if (ev.value === 0) {
      // Checkmate on the board — side to move lost
      cp = -10000;
    } else {
      cp = ev.value > 0 ? 10000 : -10000;
    }
  } else {
    cp = ev.value;
  }
  // Stockfish score is from side-to-move POV; flip if black to move
  return sideToMove === 'white' ? cp : -cp;
}

/**
 * Per-MOVE accuracy from centipawn loss (chess.com-style exponential).
 * Applied to each move individually, then averaged — NOT to average cpLoss.
 */
function moveAccuracy(cpLoss: number): number {
  if (cpLoss <= 0) return 100;
  const raw = 103.1668 * Math.exp(-0.04354 * cpLoss) - 3.1668;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Calculate player accuracy: average of per-move accuracies.
 */
function averageAccuracy(moves: { cpLoss: number }[]): number {
  if (moves.length === 0) return 100;
  const sum = moves.reduce((s, m) => s + moveAccuracy(m.cpLoss), 0);
  return Math.round((sum / moves.length) * 10) / 10;
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
      // prevEvalWhiteCp: evaluation of the position BEFORE the move, in White's centipawns
      let prevEvalWhiteCp: number | null = null;
      let prevEvalRaw: { type: 'cp' | 'mate'; value: number } | null = null;

      // Evaluate starting position (white to move)
      const startResult = await this.stockfish.analyze(chess.fen(), ANALYSIS_DEPTH);
      if (startResult.score) {
        prevEvalRaw = startResult.score;
        prevEvalWhiteCp = evalToWhiteCp(startResult.score, 'white');
      }

      for (const move of game.moves) {
        const isWhite = move.color === 'white';

        // Side to move BEFORE this move
        const sideBeforeMove: 'white' | 'black' = isWhite ? 'white' : 'black';

        // Make the move
        chess.move(move.san);

        // Side to move AFTER this move (opponent)
        const sideAfterMove: 'white' | 'black' = isWhite ? 'black' : 'white';

        // Evaluate position after move
        let evalAfterRaw: { type: 'cp' | 'mate'; value: number } | null = null;
        let evalAfterWhiteCp: number | null = null;
        let bestMoveUci: string | null = null;

        if (!chess.isGameOver()) {
          const result = await this.stockfish.analyze(chess.fen(), ANALYSIS_DEPTH);
          if (result.score) {
            evalAfterRaw = result.score;
            evalAfterWhiteCp = evalToWhiteCp(result.score, sideAfterMove);
          }
          bestMoveUci = result.bestMove !== '(none)' ? result.bestMove : null;
        } else {
          if (chess.isCheckmate()) {
            // The side that just moved delivered checkmate — great for them
            evalAfterRaw = { type: 'mate', value: 0 };
            evalAfterWhiteCp = isWhite ? 10000 : -10000;
          } else {
            evalAfterRaw = { type: 'cp', value: 0 };
            evalAfterWhiteCp = 0;
          }
        }

        // cpLoss: how much White's eval dropped (for white) or rose (for black)
        let cpLoss = 0;
        if (prevEvalWhiteCp !== null && evalAfterWhiteCp !== null) {
          if (isWhite) {
            // White wants eval to stay high; loss = before - after
            cpLoss = prevEvalWhiteCp - evalAfterWhiteCp;
          } else {
            // Black wants eval to go down; loss = after - before (from black's POV)
            cpLoss = evalAfterWhiteCp - prevEvalWhiteCp;
          }
          cpLoss = Math.min(Math.max(0, cpLoss), MAX_CP_LOSS);
        }

        const classification = classifyMove(cpLoss);

        moveAnalyses.push({
          moveNumber: move.moveNumber,
          color: move.color as 'white' | 'black',
          san: move.san,
          uci: move.uci,
          evalBefore: prevEvalRaw,
          evalAfter: evalAfterRaw,
          bestMove: bestMoveUci,
          cpLoss: Math.round(cpLoss),
          classification,
        });

        // Update for next iteration
        prevEvalRaw = evalAfterRaw;
        prevEvalWhiteCp = evalAfterWhiteCp;
      }

      // Calculate accuracy: average of per-move accuracies (not accuracy of average cpLoss!)
      const whiteMoves = moveAnalyses.filter((m) => m.color === 'white');
      const blackMoves = moveAnalyses.filter((m) => m.color === 'black');

      const whiteAccuracy = averageAccuracy(whiteMoves);
      const blackAccuracy = averageAccuracy(blackMoves);

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
