import { PuzzleGeneratorService } from './puzzle-generator.service';

describe('PuzzleGeneratorService', () => {
  let service: PuzzleGeneratorService;
  let prisma: {
    game: { findUnique: jest.Mock };
    move: { findMany: jest.Mock };
    generatedPuzzle: { create: jest.Mock };
  };
  let redis: { get: jest.Mock; set: jest.Mock };
  let stockfish: { analyzeMultiPV: jest.Mock; analyze: jest.Mock };

  beforeEach(() => {
    prisma = {
      game: { findUnique: jest.fn() },
      move: { findMany: jest.fn() },
      generatedPuzzle: { create: jest.fn() },
    };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    stockfish = {
      analyzeMultiPV: jest.fn(),
      analyze: jest.fn(),
    };
    service = new PuzzleGeneratorService(prisma as any, redis as any, stockfish as any);
  });

  it('should reject non-finished games', async () => {
    prisma.game.findUnique.mockResolvedValue({ id: 'g1', status: 'active' });
    await expect(service.generateFromGame('g1')).rejects.toThrow('not finished');
  });

  it('should reject games not found', async () => {
    prisma.game.findUnique.mockResolvedValue(null);
    await expect(service.generateFromGame('g1')).rejects.toThrow('not found');
  });

  it('should skip short games', async () => {
    prisma.game.findUnique.mockResolvedValue({ id: 'g1', status: 'finished' });
    prisma.move.findMany.mockResolvedValue([
      { uci: 'e2e4', san: 'e4', fenAfter: 'fen1' },
      { uci: 'd7d5', san: 'd5', fenAfter: 'fen2' },
    ]);

    const result = await service.generateFromGame('g1');
    expect(result.puzzlesCreated).toBe(0);
  });

  it('should create puzzles from positions with high gap', async () => {
    prisma.game.findUnique.mockResolvedValue({ id: 'g1', status: 'finished' });
    const moves = Array.from({ length: 10 }, (_, i) => ({
      uci: `e${i}e${i + 1}`,
      san: `e${i + 1}`,
      fenAfter: `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 ${i + 1}`,
    }));
    prisma.move.findMany.mockResolvedValue(moves);

    // High gap position at index 3
    stockfish.analyzeMultiPV
      .mockResolvedValueOnce([
        { pv: 'e2e4 e7e5', score: { type: 'cp', value: 200 }, bestMove: 'e2e4' },
        { pv: 'd2d4 d7d5', score: { type: 'cp', value: 0 }, bestMove: 'd2d4' },
        { pv: 'c2c4', score: { type: 'cp', value: -10 }, bestMove: 'c2c4' },
      ])
      // Remaining positions: low gap
      .mockResolvedValue([
        { pv: 'a2a3', score: { type: 'cp', value: 10 }, bestMove: 'a2a3' },
        { pv: 'b2b3', score: { type: 'cp', value: 5 }, bestMove: 'b2b3' },
      ]);

    // For building solution line
    stockfish.analyze.mockResolvedValue({ bestMove: 'd7d5', score: { type: 'cp', value: -10 } });

    prisma.generatedPuzzle.create.mockResolvedValue({});

    const result = await service.generateFromGame('g1');
    expect(result.puzzlesCreated).toBe(1);
    expect(prisma.generatedPuzzle.create).toHaveBeenCalledTimes(1);
  });

  it('should use Redis cache when available', async () => {
    prisma.game.findUnique.mockResolvedValue({ id: 'g1', status: 'finished' });
    const moves = Array.from({ length: 8 }, (_, i) => ({
      uci: `e${i}e${i + 1}`,
      san: `e${i + 1}`,
      fenAfter: `fen${i}`,
    }));
    prisma.move.findMany.mockResolvedValue(moves);

    // Cache returns low gap for all
    redis.get.mockResolvedValue(JSON.stringify({ gap: 10, bestMove: 'e2e4' }));

    const result = await service.generateFromGame('g1');
    expect(result.puzzlesCreated).toBe(0);
    expect(stockfish.analyzeMultiPV).not.toHaveBeenCalled();
  });
});
