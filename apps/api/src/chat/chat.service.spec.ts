jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { ChatService } from './chat.service';

describe('ChatService', () => {
  let service: ChatService;
  let prisma: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const gameId = 'game-1';

  beforeEach(() => {
    prisma = {
      chatMessage: {
        create: jest.fn(),
      },
    } as any;

    const i18n = { t: jest.fn((key: string) => key) } as any;
    service = new ChatService(prisma, i18n);
  });

  describe('sendMessage', () => {
    it('should create message and return formatted result', async () => {
      const createdAt = new Date('2026-01-01T12:00:00Z');
      prisma.chatMessage.create.mockResolvedValue({
        id: 'msg-1',
        gameId,
        userId,
        content: 'Hello',
        createdAt,
        user: { id: userId, username: 'player1' },
      });

      const result = await service.sendMessage(gameId, userId, 'Hello');

      expect(result).toEqual({
        userId,
        username: 'player1',
        content: 'Hello',
        timestamp: createdAt.toISOString(),
      });
    });

    it('should pass correct data to prisma create', async () => {
      prisma.chatMessage.create.mockResolvedValue({
        id: 'msg-1',
        gameId,
        userId,
        content: 'Test',
        createdAt: new Date(),
        user: { id: userId, username: 'player1' },
      });

      await service.sendMessage(gameId, userId, 'Test');

      expect(prisma.chatMessage.create).toHaveBeenCalledWith({
        data: { gameId, userId, content: 'Test' },
        include: {
          user: { select: { id: true, username: true } },
        },
      });
    });

    it('should propagate prisma errors', async () => {
      prisma.chatMessage.create.mockRejectedValue(new Error('DB error'));

      await expect(
        service.sendMessage(gameId, userId, 'Hello'),
      ).rejects.toThrow('DB error');
    });
  });
});
