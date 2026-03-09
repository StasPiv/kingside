/**
 * E2E-like integration tests for complete game flows.
 * Tests full scenarios: game creation -> moves -> game end -> rating update.
 */
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import { GameService } from './game.service';
import { GameClockService, ClockState } from './game-clock.service';
import { STOCKFISH_BOT_ID, INITIAL_FEN } from '@kingside/shared';

describe('GameService E2E Scenarios', () => {
  let service: GameService;
  let prisma: any;
  let redis: any;
  let clockService: jest.Mocked<GameClockService>;
  let ratingService: any;
  let i18n: any;

  const whiteId = '11111111-1111-4111-a111-111111111111';
  const blackId = '22222222-2222-4222-a222-222222222222';

  const mockClocks: ClockState = {
    whiteMs: 300000,
    blackMs: 300000,
    lastTick: Date.now(),
    running: true,
  };

  beforeEach(() => {
    prisma = {
      game: {
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      move: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    } as any;

    redis = {
      hset: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    } as any;

    clockService = {
      initClocks: jest.fn().mockResolvedValue(mockClocks),
      startClock: jest.fn().mockResolvedValue(undefined),
      switchClock: jest.fn().mockResolvedValue(mockClocks),
      stopClock: jest.fn().mockResolvedValue(mockClocks),
      getClocks: jest.fn().mockResolvedValue(mockClocks),
      checkTimeout: jest.fn().mockResolvedValue({ timedOut: false, clocks: mockClocks }),
      deleteClock: jest.fn().mockResolvedValue(undefined),
    } as any;

    ratingService = {
      updateRatingsAfterGame: jest.fn().mockResolvedValue(undefined),
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    } as any;

    service = new GameService(prisma, redis, clockService, ratingService, i18n);
  });

  describe('Full game: Scholar\'s Mate', () => {
    // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
    const moves = [
      { uci: 'e2e4', expectedSan: 'e4', player: whiteId },
      { uci: 'e7e5', expectedSan: 'e5', player: blackId },
      { uci: 'f1c4', expectedSan: 'Bc4', player: whiteId },
      { uci: 'b8c6', expectedSan: 'Nc6', player: blackId },
      { uci: 'd1h5', expectedSan: 'Qh5', player: whiteId },
      { uci: 'g8f6', expectedSan: 'Nf6', player: blackId },
      { uci: 'h5f7', expectedSan: 'Qxf7#', player: whiteId },
    ];

    it('should play full game ending in checkmate', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        timeIncrementSec: 0,
        status: 'active',
      });
      prisma.game.update.mockResolvedValue({});

      let currentFen = INITIAL_FEN;
      let currentMoves: any[] = [];
      let activeColor = 'white';

      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];

        redis.hgetall.mockResolvedValue({
          fen: currentFen,
          moves: JSON.stringify(currentMoves),
          active_color: activeColor,
          status: 'active',
        });

        const result = await service.makeMove('game-1', move.player, move.uci);

        expect(result.san).toBe(move.expectedSan);

        currentFen = result.fen;
        currentMoves.push({ uci: move.uci, san: result.san });
        activeColor = activeColor === 'white' ? 'black' : 'white';

        if (i < moves.length - 1) {
          expect(result.gameOver).toBe(false);
        } else {
          // Last move - checkmate
          expect(result.gameOver).toBe(true);
          expect(result.result).toBe('white');
          expect(result.termination).toBe('checkmate');
        }
      }

      expect(ratingService.updateRatingsAfterGame).toHaveBeenCalledWith('game-1', 'white');
    });
  });

  describe('Draw by agreement', () => {
    it('should handle full draw offer flow', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        status: 'active',
      });
      prisma.game.update.mockResolvedValue({});
      redis.hgetall.mockResolvedValue({ fen: INITIAL_FEN });

      // White offers draw
      await service.handleDrawOffer('game-1', whiteId);
      expect(redis.set).toHaveBeenCalledWith(
        'game:game-1:draw_offer',
        whiteId,
        'EX',
        120,
      );

      // Black accepts draw
      redis.get.mockResolvedValue(whiteId);
      const result = await service.handleDrawAccept('game-1', blackId);

      expect(result.result).toBe('draw');
      expect(result.termination).toBe('draw_agreement');
      expect(clockService.stopClock).toHaveBeenCalled();
    });

    it('should reject draw accept from same player who offered', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        status: 'active',
      });
      redis.get.mockResolvedValue(whiteId); // white offered

      await expect(
        service.handleDrawAccept('game-1', whiteId),
      ).rejects.toThrow('messages.game.noDrawOffer');
    });

    it('should reject draw accept when no offer exists', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        status: 'active',
      });
      redis.get.mockResolvedValue(null);

      await expect(
        service.handleDrawAccept('game-1', blackId),
      ).rejects.toThrow('messages.game.noDrawOffer');
    });

    it('should allow declining a draw', async () => {
      await service.handleDrawDecline('game-1', blackId);

      expect(redis.del).toHaveBeenCalledWith('game:game-1:draw_offer');
    });
  });

  describe('Resignation flow', () => {
    it('should complete resignation and update ratings', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        status: 'active',
      });
      prisma.game.update.mockResolvedValue({});
      redis.hgetall.mockResolvedValue({ fen: INITIAL_FEN });

      const result = await service.resign('game-1', whiteId);

      expect(result.result).toBe('black');
      expect(result.termination).toBe('resignation');
      expect(clockService.stopClock).toHaveBeenCalledWith('game-1');
      expect(ratingService.updateRatingsAfterGame).toHaveBeenCalledWith('game-1', 'black');
    });
  });

  describe('Chess rules: special moves', () => {
    it('should handle castling (kingside)', async () => {
      // Position ready for white kingside castling
      const fen = 'r1bqk2r/ppppbppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({
        fen,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const result = await service.makeMove('game-1', whiteId, 'e1g1');

      expect(result.san).toBe('O-O');
      expect(result.gameOver).toBe(false);
    });

    it('should handle castling (queenside)', async () => {
      // Position ready for white queenside castling
      const fen = 'r3kbnr/pppqpppp/2n5/3p1b2/3P1B2/2N5/PPPQPPPP/R3KBNR w KQkq - 6 4';

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({
        fen,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const result = await service.makeMove('game-1', whiteId, 'e1c1');

      expect(result.san).toBe('O-O-O');
    });

    it('should handle en passant', async () => {
      // Position after 1.e4 d5 2.e5 f5 - white can capture en passant
      const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({
        fen,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const result = await service.makeMove('game-1', whiteId, 'e5f6');

      expect(result.san).toBe('exf6');
      expect(result.gameOver).toBe(false);
    });

    it('should handle pawn promotion to queen', async () => {
      const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({
        fen,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const result = await service.makeMove('game-1', whiteId, 'a7a8q');

      expect(result.san).toContain('a8=Q');
    });

    it('should handle pawn promotion to knight', async () => {
      const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({
        fen,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const result = await service.makeMove('game-1', whiteId, 'a7a8n');

      expect(result.san).toContain('a8=N');
    });

    it('should detect insufficient material (K vs K)', async () => {
      // King vs King position
      const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
      // After promotion capture leads to K vs K - but let's use a simpler approach
      // Position where a capture results in K vs K
      const fenKvsKB = '4k3/8/8/8/8/5b2/8/4K3 w - - 0 1';

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeIncrementSec: 0,
        status: 'active',
      });
      // Position: K+B vs K, which IS insufficient material
      redis.hgetall.mockResolvedValue({
        fen: '8/8/4k3/8/8/5K2/4B3/8 w - - 0 1',
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      // Make a move that doesn't capture
      const result = await service.makeMove('game-1', whiteId, 'f3e3');

      // K+B vs K is insufficient material
      expect(result.gameOver).toBe(true);
      expect(result.result).toBe('draw');
      expect(result.termination).toBe('insufficient');
    });
  });

  describe('Bot game: create and play', () => {
    it('should create bot game then make a move', async () => {
      const mockGame = {
        id: 'bot-game-1',
        whiteId,
        blackId: STOCKFISH_BOT_ID,
        timeControlType: 'blitz',
        timeInitialSec: 300,
        timeIncrementSec: 0,
        status: 'active',
        isBot: true,
        botLevel: 3,
        white: { id: whiteId, username: 'player1' },
        black: { id: STOCKFISH_BOT_ID, username: 'Stockfish Bot' },
      };

      prisma.game.create.mockResolvedValue(mockGame);
      prisma.game.findUniqueOrThrow.mockResolvedValue(mockGame);
      prisma.game.update.mockResolvedValue(mockGame);

      // Create bot game
      await service.createGameWithBot(whiteId, 'white', 3, 'blitz');

      expect(prisma.game.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isBot: true,
          botLevel: 3,
          whiteId,
          blackId: STOCKFISH_BOT_ID,
        }),
      });

      // Make first move
      redis.hgetall.mockResolvedValue({
        fen: INITIAL_FEN,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const moveResult = await service.makeMove('bot-game-1', whiteId, 'e2e4');

      expect(moveResult.san).toBe('e4');
      expect(moveResult.gameOver).toBe(false);
    });
  });

  describe('Multiplayer game: matchmaking to completion', () => {
    it('should handle full two-player game flow', async () => {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        timeIncrementSec: 3,
        status: 'active',
      });
      prisma.game.update.mockResolvedValue({});

      // Move 1: White e4
      redis.hgetall.mockResolvedValue({
        fen: INITIAL_FEN,
        moves: '[]',
        active_color: 'white',
        status: 'active',
      });

      const move1 = await service.makeMove('game-1', whiteId, 'e2e4');
      expect(move1.san).toBe('e4');

      // Verify increment is passed to clock
      expect(clockService.switchClock).toHaveBeenCalledWith('game-1', 'white', 3000);

      // Move 2: Black e5
      redis.hgetall.mockResolvedValue({
        fen: move1.fen,
        moves: JSON.stringify([{ uci: 'e2e4', san: 'e4' }]),
        active_color: 'black',
        status: 'active',
      });

      const move2 = await service.makeMove('game-1', blackId, 'e7e5');
      expect(move2.san).toBe('e5');

      // White resigns
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({ fen: move2.fen });

      const endResult = await service.resign('game-1', whiteId);

      expect(endResult.result).toBe('black');
      expect(endResult.termination).toBe('resignation');
      expect(ratingService.updateRatingsAfterGame).toHaveBeenCalledWith('game-1', 'black');
    });
  });

  describe('KS-362: Short game resignation rating update', () => {
    it('should update ratings when white resigns after 4 moves', async () => {
      const ratingChangeResult = {
        whiteRatingBefore: 1530,
        whiteRatingAfter: 1512,
        blackRatingBefore: 1470,
        blackRatingAfter: 1488,
      };
      ratingService.updateRatingsAfterGame.mockResolvedValue(ratingChangeResult);

      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        timeIncrementSec: 0,
        status: 'active',
      });
      prisma.game.update.mockResolvedValue({});

      // Play 4 moves: 1.e4 e5 2.Nf3 Nc6
      const positions = [
        { uci: 'e2e4', player: whiteId, color: 'white' },
        { uci: 'e7e5', player: blackId, color: 'black' },
        { uci: 'g1f3', player: whiteId, color: 'white' },
        { uci: 'b8c6', player: blackId, color: 'black' },
      ];

      let currentFen = INITIAL_FEN;
      let currentMoves: any[] = [];
      let activeColor = 'white';

      for (const pos of positions) {
        redis.hgetall.mockResolvedValue({
          fen: currentFen,
          moves: JSON.stringify(currentMoves),
          active_color: activeColor,
          status: 'active',
        });

        const result = await service.makeMove('game-1', pos.player, pos.uci);
        currentFen = result.fen;
        currentMoves.push({ uci: pos.uci, san: result.san });
        activeColor = activeColor === 'white' ? 'black' : 'white';
      }

      // White resigns after 4 moves
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        status: 'active',
      });
      redis.hgetall.mockResolvedValue({ fen: currentFen });

      const endResult = await service.resign('game-1', whiteId);

      expect(endResult.result).toBe('black');
      expect(endResult.termination).toBe('resignation');
      expect(endResult.ratingChange).toEqual(ratingChangeResult);
      expect(ratingService.updateRatingsAfterGame).toHaveBeenCalledWith('game-1', 'black');
    });
  });
});
