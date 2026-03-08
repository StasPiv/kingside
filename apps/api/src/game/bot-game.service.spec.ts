jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../engine/stockfish.service', () => ({
  StockfishService: jest.fn(),
}));
jest.mock('./game.service', () => ({
  GameService: jest.fn(),
}));

import { BotGameService } from './bot-game.service';
import { STOCKFISH_BOT_ID, STOCKFISH_BOT_USERNAME } from '@kingside/shared';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

describe('BotGameService', () => {
  let service: BotGameService;
  let prisma: any;
  let gameService: any;
  let stockfish: any;

  const gameId = 'game-001';
  const humanId = 'human-player';

  beforeEach(() => {
    prisma = {
      user: {
        upsert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
      game: {
        findUniqueOrThrow: jest.fn(),
      },
    };

    gameService = {
      getGameState: jest.fn(),
      makeMove: jest.fn(),
    };

    stockfish = {
      getBestMove: jest.fn(),
    };

    service = new BotGameService(prisma, gameService, stockfish);
  });

  describe('isBotPlayer', () => {
    it('should return true for bot ID', () => {
      expect(service.isBotPlayer(STOCKFISH_BOT_ID)).toBe(true);
    });

    it('should return false for human ID', () => {
      expect(service.isBotPlayer(humanId)).toBe(false);
    });
  });

  describe('ensureBotUser (via onModuleInit)', () => {
    it('should upsert bot user on init', async () => {
      await service.onModuleInit();

      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where: { id: STOCKFISH_BOT_ID },
        update: {},
        create: {
          id: STOCKFISH_BOT_ID,
          username: STOCKFISH_BOT_USERNAME,
          email: 'stockfish-bot@kingside.local',
          passwordHash: '',
        },
      });
    });

    it('should handle P2002 conflict by updating existing record', async () => {
      const err = new PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      prisma.user.upsert.mockRejectedValue(err);

      await service.onModuleInit();

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { email: 'stockfish-bot@kingside.local' },
        data: { id: STOCKFISH_BOT_ID, username: STOCKFISH_BOT_USERNAME },
      });
    });

    it('should rethrow non-P2002 errors', async () => {
      prisma.user.upsert.mockRejectedValue(new Error('DB down'));

      await expect(service.onModuleInit()).rejects.toThrow('DB down');
    });
  });

  describe('maybeBotReply', () => {
    it('should return null if game is not active', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: humanId,
        blackId: STOCKFISH_BOT_ID,
        status: 'finished',
        botLevel: 5,
      });

      const result = await service.maybeBotReply(gameId);

      expect(result).toBeNull();
    });

    it('should return null if next player is not bot', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: humanId,
        blackId: STOCKFISH_BOT_ID,
        status: 'active',
        botLevel: 5,
      });
      gameService.getGameState.mockResolvedValue({
        state: { activeColor: 'white', fen: 'startpos' },
      });

      const result = await service.maybeBotReply(gameId);

      expect(result).toBeNull();
      expect(stockfish.getBestMove).not.toHaveBeenCalled();
    });

    it('should make bot move when it is bot turn', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: humanId,
        blackId: STOCKFISH_BOT_ID,
        status: 'active',
        botLevel: 10,
      });
      gameService.getGameState.mockResolvedValue({
        state: { activeColor: 'black', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' },
      });
      stockfish.getBestMove.mockResolvedValue({ bestMove: 'e7e5' });
      gameService.makeMove.mockResolvedValue({
        san: 'e5',
        fen: 'some-fen',
        clocks: {},
        gameOver: false,
      });

      const result = await service.maybeBotReply(gameId);

      expect(stockfish.getBestMove).toHaveBeenCalledWith(
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        10,
      );
      expect(gameService.makeMove).toHaveBeenCalledWith(gameId, STOCKFISH_BOT_ID, 'e7e5');
      expect(result).toMatchObject({ uci: 'e7e5', san: 'e5' });
    });

    it('should default to level 5 when botLevel is null', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: STOCKFISH_BOT_ID,
        blackId: humanId,
        status: 'active',
        botLevel: null,
      });
      gameService.getGameState.mockResolvedValue({
        state: { activeColor: 'white', fen: 'startpos' },
      });
      stockfish.getBestMove.mockResolvedValue({ bestMove: 'e2e4' });
      gameService.makeMove.mockResolvedValue({
        san: 'e4',
        fen: 'fen',
        clocks: {},
        gameOver: false,
      });

      await service.maybeBotReply(gameId);

      expect(stockfish.getBestMove).toHaveBeenCalledWith('startpos', 5);
    });

    it('should return null on stockfish error', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId: STOCKFISH_BOT_ID,
        blackId: humanId,
        status: 'active',
        botLevel: 5,
      });
      gameService.getGameState.mockResolvedValue({
        state: { activeColor: 'white', fen: 'startpos' },
      });
      stockfish.getBestMove.mockRejectedValue(new Error('Engine crash'));

      const result = await service.maybeBotReply(gameId);

      expect(result).toBeNull();
    });
  });
});
