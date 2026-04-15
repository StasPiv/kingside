import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class GameReportService {
  private readonly logger = new Logger(GameReportService.name);

  constructor(
    private readonly prisma: PrismaService,
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

    // Server-side Stockfish removed — analysis runs client-side (WASM)
    throw new ConflictException('Server-side analysis is not available. Use client-side Stockfish (WASM).');
  }
}
