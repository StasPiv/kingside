jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import { GameGateway } from './game.gateway';
import { ClockState } from './game-clock.service';

describe('GameGateway', () => {
  let gateway: GameGateway;
  let gameService: any;
  let botGameService: any;
  let jwtService: any;
  let chatService: any;
  let mockServer: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const opponentId = '22222222-2222-4222-a222-222222222222';
  const gameId = 'game-1';

  const mockClocks: ClockState = {
    whiteMs: 300000,
    blackMs: 300000,
    lastTick: Date.now(),
    running: true,
  };

  function createMockClient(userData?: any): any {
    return {
      id: 'socket-1',
      data: { user: userData || { id: userId, username: 'player1' } },
      handshake: { auth: { token: 'valid-token' }, query: {} },
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      to: jest.fn().mockReturnThis(),
      disconnect: jest.fn(),
    };
  }

  beforeEach(() => {
    gameService = {
      getGameState: jest.fn(),
      makeMove: jest.fn(),
      resign: jest.fn(),
      handleDrawOffer: jest.fn(),
      handleDrawAccept: jest.fn(),
      handleDrawDecline: jest.fn(),
    } as any;

    botGameService = {
      maybeBotReply: jest.fn().mockResolvedValue(null),
    } as any;

    jwtService = {
      verify: jest.fn().mockReturnValue({ sub: userId, username: 'player1' }),
    } as any;

    chatService = {
      sendMessage: jest.fn(),
    } as any;

    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    } as any;

    gateway = new GameGateway(gameService, botGameService, jwtService, chatService);
    gateway.server = mockServer;
  });

  describe('handleConnection', () => {
    it('should authenticate client with valid token', async () => {
      const client = createMockClient(undefined);
      client.data = {};

      await gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith('valid-token');
      expect(client.data.user).toEqual({ id: userId, username: 'player1' });
    });

    it('should disconnect client without token', async () => {
      const client = createMockClient(undefined);
      client.data = {};
      client.handshake = { auth: {}, query: {} };

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalled();
    });

    it('should disconnect client with invalid token', async () => {
      const client = createMockClient(undefined);
      client.data = {};
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalled();
    });
  });

  describe('handleJoinGame', () => {
    it('should join game room and emit state', async () => {
      const client = createMockClient();
      gameService.getGameState.mockResolvedValue({
        state: {
          fen: 'startpos',
          moves: [{ san: 'e4' }],
          status: 'active',
        },
        clocks: mockClocks,
        whiteId: userId,
        blackId: opponentId,
        players: { white: 'player1', black: 'player2' },
        isBot: false,
        botLevel: null,
      });

      await gateway.handleJoinGame(client, { gameId });

      expect(client.join).toHaveBeenCalledWith(`game:${gameId}`);
      expect(client.emit).toHaveBeenCalledWith('game:state', {
        gameId,
        fen: 'startpos',
        moves: ['e4'],
        clocks: { whiteMs: mockClocks.whiteMs, blackMs: mockClocks.blackMs },
        status: 'active',
        color: 'white',
        players: { white: 'player1', black: 'player2' },
        isBot: false,
        botLevel: null,
      });
    });

    it('should return without action when user not authenticated', async () => {
      const client = createMockClient(undefined);
      client.data = { user: undefined };

      await gateway.handleJoinGame(client, { gameId });

      expect(client.join).not.toHaveBeenCalled();
    });

    it('should set color to black for black player', async () => {
      const client = createMockClient();
      gameService.getGameState.mockResolvedValue({
        state: { fen: 'startpos', moves: [], status: 'active' },
        clocks: mockClocks,
        whiteId: opponentId,
        blackId: userId,
        players: { white: 'player2', black: 'player1' },
        isBot: false,
        botLevel: null,
      });

      await gateway.handleJoinGame(client, { gameId });

      expect(client.emit).toHaveBeenCalledWith(
        'game:state',
        expect.objectContaining({ color: 'black' }),
      );
    });

    it('should set color to undefined for spectator', async () => {
      const client = createMockClient({ id: 'spectator-id', username: 'spec' });
      gameService.getGameState.mockResolvedValue({
        state: { fen: 'startpos', moves: [], status: 'active' },
        clocks: mockClocks,
        whiteId: userId,
        blackId: opponentId,
        players: { white: 'player1', black: 'player2' },
        isBot: false,
        botLevel: null,
      });

      await gateway.handleJoinGame(client, { gameId });

      expect(client.emit).toHaveBeenCalledWith(
        'game:state',
        expect.objectContaining({ color: undefined }),
      );
    });
  });

  describe('handleMove', () => {
    it('should broadcast move to room on success', async () => {
      const client = createMockClient();
      const moveFlags = { captured: false, isCheck: false, isCastle: false, isPromotion: false };
      gameService.makeMove.mockResolvedValue({
        san: 'e4',
        fen: 'new-fen',
        clocks: mockClocks,
        gameOver: false,
        moveFlags,
      });

      await gateway.handleMove(client, { gameId, uci: 'e2e4' });

      expect(client.to).toHaveBeenCalledWith(`game:${gameId}`);
      expect(client.emit).toHaveBeenCalledWith('game:move', {
        uci: 'e2e4',
        san: 'e4',
        fen: 'new-fen',
        clocks: { whiteMs: mockClocks.whiteMs, blackMs: mockClocks.blackMs },
        moveFlags,
      });
    });

    it('should include capture flag when piece is captured', async () => {
      const client = createMockClient();
      const moveFlags = { captured: true, isCheck: false, isCastle: false, isPromotion: false };
      gameService.makeMove.mockResolvedValue({
        san: 'exd5',
        fen: 'capture-fen',
        clocks: mockClocks,
        gameOver: false,
        moveFlags,
      });

      await gateway.handleMove(client, { gameId, uci: 'e4d5' });

      expect(client.emit).toHaveBeenCalledWith('game:move',
        expect.objectContaining({ moveFlags }),
      );
    });

    it('should include check flag when move results in check', async () => {
      const client = createMockClient();
      const moveFlags = { captured: false, isCheck: true, isCastle: false, isPromotion: false };
      gameService.makeMove.mockResolvedValue({
        san: 'Qh5+',
        fen: 'check-fen',
        clocks: mockClocks,
        gameOver: false,
        moveFlags,
      });

      await gateway.handleMove(client, { gameId, uci: 'd1h5' });

      expect(client.emit).toHaveBeenCalledWith('game:move',
        expect.objectContaining({ moveFlags }),
      );
    });

    it('should include castle flag when castling', async () => {
      const client = createMockClient();
      const moveFlags = { captured: false, isCheck: false, isCastle: true, isPromotion: false };
      gameService.makeMove.mockResolvedValue({
        san: 'O-O',
        fen: 'castle-fen',
        clocks: mockClocks,
        gameOver: false,
        moveFlags,
      });

      await gateway.handleMove(client, { gameId, uci: 'e1g1' });

      expect(client.emit).toHaveBeenCalledWith('game:move',
        expect.objectContaining({ moveFlags }),
      );
    });

    it('should include promotion flag when pawn promotes', async () => {
      const client = createMockClient();
      const moveFlags = { captured: false, isCheck: false, isCastle: false, isPromotion: true };
      gameService.makeMove.mockResolvedValue({
        san: 'e8=Q',
        fen: 'promo-fen',
        clocks: mockClocks,
        gameOver: false,
        moveFlags,
      });

      await gateway.handleMove(client, { gameId, uci: 'e7e8q' });

      expect(client.emit).toHaveBeenCalledWith('game:move',
        expect.objectContaining({ moveFlags }),
      );
    });

    it('should emit game:end on game over', async () => {
      const client = createMockClient();
      gameService.makeMove.mockResolvedValue({
        san: 'Qh4#',
        fen: 'mate-fen',
        clocks: mockClocks,
        gameOver: true,
        result: 'black',
        termination: 'checkmate',
        moveFlags: { captured: false, isCheck: true, isCastle: false, isPromotion: false },
      });

      await gateway.handleMove(client, { gameId, uci: 'd8h4' });

      expect(mockServer.to).toHaveBeenCalledWith(`game:${gameId}`);
      expect(mockServer.emit).toHaveBeenCalledWith('game:end', {
        result: 'black',
        termination: 'checkmate',
      });
    });

    it('should emit error on invalid move', async () => {
      const client = createMockClient();
      gameService.makeMove.mockRejectedValue(new Error('Invalid move'));
      gameService.getGameState.mockResolvedValue({
        state: { fen: 'startpos', moves: [], status: 'active' },
        clocks: mockClocks,
      });

      await gateway.handleMove(client, { gameId, uci: 'e2e5' });

      expect(client.emit).toHaveBeenCalledWith('error', {
        code: 'INVALID_MOVE',
        message: 'Invalid move',
      });
      // Should also resync state
      expect(client.emit).toHaveBeenCalledWith('game:state', expect.any(Object));
    });

    it('should not act when user not authenticated', async () => {
      const client = createMockClient(undefined);
      client.data = { user: undefined };

      await gateway.handleMove(client, { gameId, uci: 'e2e4' });

      expect(gameService.makeMove).not.toHaveBeenCalled();
    });
  });

  describe('handleResign', () => {
    it('should emit game:end on resign', async () => {
      const client = createMockClient();
      gameService.resign.mockResolvedValue({
        result: 'black',
        termination: 'resignation',
      });

      await gateway.handleResign(client, { gameId });

      expect(mockServer.to).toHaveBeenCalledWith(`game:${gameId}`);
      expect(mockServer.emit).toHaveBeenCalledWith('game:end', {
        result: 'black',
        termination: 'resignation',
      });
    });

    it('should emit error on resign failure', async () => {
      const client = createMockClient();
      gameService.resign.mockRejectedValue(new Error('Not active'));

      await gateway.handleResign(client, { gameId });

      expect(client.emit).toHaveBeenCalledWith('error', {
        code: 'RESIGN_ERROR',
        message: 'Not active',
      });
    });
  });

  describe('handleDrawOffer', () => {
    it('should broadcast draw offer to room', async () => {
      const client = createMockClient();
      gameService.handleDrawOffer.mockResolvedValue(undefined);

      await gateway.handleDrawOffer(client, { gameId });

      expect(client.to).toHaveBeenCalledWith(`game:${gameId}`);
      expect(client.emit).toHaveBeenCalledWith('game:draw:offered', { gameId });
    });

    it('should emit error on draw offer failure', async () => {
      const client = createMockClient();
      gameService.handleDrawOffer.mockRejectedValue(new Error('Not active'));

      await gateway.handleDrawOffer(client, { gameId });

      expect(client.emit).toHaveBeenCalledWith('error', {
        code: 'DRAW_OFFER_ERROR',
        message: 'Not active',
      });
    });
  });

  describe('handleDrawAccept', () => {
    it('should emit game:end on draw accept', async () => {
      const client = createMockClient();
      gameService.handleDrawAccept.mockResolvedValue({
        result: 'draw',
        termination: 'draw_agreement',
      });

      await gateway.handleDrawAccept(client, { gameId });

      expect(mockServer.to).toHaveBeenCalledWith(`game:${gameId}`);
      expect(mockServer.emit).toHaveBeenCalledWith('game:end', {
        result: 'draw',
        termination: 'draw_agreement',
      });
    });

    it('should emit error on draw accept failure', async () => {
      const client = createMockClient();
      gameService.handleDrawAccept.mockRejectedValue(new Error('No offer'));

      await gateway.handleDrawAccept(client, { gameId });

      expect(client.emit).toHaveBeenCalledWith('error', {
        code: 'DRAW_ACCEPT_ERROR',
        message: 'No offer',
      });
    });
  });

  describe('handleDrawDecline', () => {
    it('should call gameService handleDrawDecline', async () => {
      const client = createMockClient();

      await gateway.handleDrawDecline(client, { gameId });

      expect(gameService.handleDrawDecline).toHaveBeenCalledWith(gameId, userId);
    });
  });

  describe('handleChatSend', () => {
    it('should broadcast chat message to room', async () => {
      const client = createMockClient();
      const message = {
        userId,
        username: 'player1',
        content: 'Hello',
        timestamp: '2026-01-01T12:00:00.000Z',
      };
      chatService.sendMessage.mockResolvedValue(message);

      await gateway.handleChatSend(client, { gameId, content: 'Hello' });

      expect(chatService.sendMessage).toHaveBeenCalledWith(gameId, userId, 'Hello');
      expect(mockServer.to).toHaveBeenCalledWith(`game:${gameId}`);
      expect(mockServer.emit).toHaveBeenCalledWith('chat:message', message);
    });

    it('should emit error on chat failure', async () => {
      const client = createMockClient();
      chatService.sendMessage.mockRejectedValue(new Error('Chat error'));

      await gateway.handleChatSend(client, { gameId, content: 'Hello' });

      expect(client.emit).toHaveBeenCalledWith('error', {
        code: 'CHAT_ERROR',
        message: 'Chat error',
      });
    });
  });
});
