import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { GameReportService } from './game-report.service';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../engine/stockfish.service';

describe('GameReportService', () => {
  let service: GameReportService;
  let prisma: {
    game: { findUnique: jest.Mock };
    gameReport: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let stockfish: { analyze: jest.Mock };

  beforeEach(async () => {
    prisma = {
      game: { findUnique: jest.fn() },
      gameReport: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    stockfish = { analyze: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: StockfishService, useValue: stockfish },
      ],
    }).compile();

    service = module.get<GameReportService>(GameReportService);
  });

  describe('getReport', () => {
    it('should return null when no report exists', async () => {
      prisma.gameReport.findUnique.mockResolvedValue(null);
      const result = await service.getReport('game-1');
      expect(result).toBeNull();
    });

    it('should return parsed report when exists', async () => {
      prisma.gameReport.findUnique.mockResolvedValue({
        id: 'report-1',
        gameId: 'game-1',
        whiteAccuracy: 85.5,
        blackAccuracy: 72.3,
        moves: JSON.stringify([{ moveNumber: 1, color: 'white', san: 'e4', cpLoss: 0, classification: 'best' }]),
        status: 'complete',
      });

      const result = await service.getReport('game-1');
      expect(result).not.toBeNull();
      expect(result!.whiteAccuracy).toBe(85.5);
      expect(result!.moves).toHaveLength(1);
      expect(result!.moves[0].classification).toBe('best');
    });
  });

  describe('analyze', () => {
    it('should return existing complete report', async () => {
      prisma.gameReport.findUnique.mockResolvedValue({
        id: 'report-1',
        gameId: 'game-1',
        whiteAccuracy: 90,
        blackAccuracy: 80,
        moves: '[]',
        status: 'complete',
      });

      const result = await service.analyze('game-1');
      expect(result.status).toBe('complete');
      expect(stockfish.analyze).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing game', async () => {
      prisma.gameReport.findUnique.mockResolvedValue(null);
      prisma.game.findUnique.mockResolvedValue(null);

      await expect(service.analyze('missing')).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException for unfinished game', async () => {
      prisma.gameReport.findUnique.mockResolvedValue(null);
      prisma.game.findUnique.mockResolvedValue({ id: 'game-1', status: 'active', moves: [{ uci: 'e2e4' }] });

      await expect(service.analyze('game-1')).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException for game with no moves', async () => {
      prisma.gameReport.findUnique.mockResolvedValue(null);
      prisma.game.findUnique.mockResolvedValue({ id: 'game-1', status: 'finished', moves: [] });

      await expect(service.analyze('game-1')).rejects.toThrow(ConflictException);
    });

    it('should analyze game and calculate accuracy', async () => {
      prisma.gameReport.findUnique.mockResolvedValue(null);
      prisma.game.findUnique.mockResolvedValue({
        id: 'game-1',
        status: 'finished',
        moves: [
          { moveNumber: 1, color: 'white', san: 'e4', uci: 'e2e4', fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' },
          { moveNumber: 1, color: 'black', san: 'e5', uci: 'e7e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2' },
        ],
      });
      prisma.gameReport.create.mockResolvedValue({
        id: 'report-1', gameId: 'game-1', status: 'analyzing',
        whiteAccuracy: 0, blackAccuracy: 0, moves: '[]',
      });
      prisma.gameReport.update.mockImplementation(async ({ data }) => ({
        id: 'report-1', gameId: 'game-1', ...data,
      }));

      // Mock stockfish: starting pos, after e4, after e5
      stockfish.analyze
        .mockResolvedValueOnce({ bestMove: 'e2e4', score: { type: 'cp', value: 20 }, depth: 18 })  // start pos
        .mockResolvedValueOnce({ bestMove: 'e7e5', score: { type: 'cp', value: -30 }, depth: 18 }) // after e4
        .mockResolvedValueOnce({ bestMove: 'd2d4', score: { type: 'cp', value: 25 }, depth: 18 }); // after e5

      const result = await service.analyze('game-1');

      expect(result.status).toBe('complete');
      expect(result.moves).toHaveLength(2);
      expect(result.whiteAccuracy).toBeGreaterThan(0);
      expect(result.blackAccuracy).toBeGreaterThan(0);
      expect(stockfish.analyze).toHaveBeenCalledTimes(3); // start + 2 moves
    });
  });
});
