jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { RatingService } from './rating.service';

describe('RatingService', () => {
  let service: RatingService;
  let prisma: any;

  const gameId = 'game-1';
  const whiteId = '11111111-1111-4111-a111-111111111111';
  const blackId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    prisma = {
      game: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new RatingService(prisma);
  });

  it('should update ratings when white wins (equal ratings)', async () => {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'blitz',
      isBot: false,
    });
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ ratingBlitz: 1500 }) // white
      .mockResolvedValueOnce({ ratingBlitz: 1500 }); // black

    await service.updateRatingsAfterGame(gameId, 'white');

    // K=32, expected=0.5, white scores 1 -> +16, black scores 0 -> -16
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: whiteId },
      data: { ratingBlitz: 1516 },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: blackId },
      data: { ratingBlitz: 1484 },
    });
  });

  it('should update ratings when black wins', async () => {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'rapid',
      isBot: false,
    });
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ ratingRapid: 1500 })
      .mockResolvedValueOnce({ ratingRapid: 1500 });

    await service.updateRatingsAfterGame(gameId, 'black');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: whiteId },
      data: { ratingRapid: 1484 },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: blackId },
      data: { ratingRapid: 1516 },
    });
  });

  it('should handle draw (equal ratings -> no change)', async () => {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'blitz',
      isBot: false,
    });
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ ratingBlitz: 1500 })
      .mockResolvedValueOnce({ ratingBlitz: 1500 });

    await service.updateRatingsAfterGame(gameId, 'draw');

    // Equal ratings, draw: expected = 0.5, score = 0.5 -> change = 0
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: whiteId },
      data: { ratingBlitz: 1500 },
    });
  });

  it('should give more points for upset wins', async () => {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'blitz',
      isBot: false,
    });
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ ratingBlitz: 1200 }) // white (underdog)
      .mockResolvedValueOnce({ ratingBlitz: 1600 }); // black (favorite)

    await service.updateRatingsAfterGame(gameId, 'white');

    // White (lower rated) wins -> should gain more than 16
    const whiteUpdate = prisma.user.update.mock.calls.find(
      (c: any) => c[0].where.id === whiteId,
    );
    const newWhiteRating = whiteUpdate[0].data.ratingBlitz;
    expect(newWhiteRating - 1200).toBeGreaterThan(16);
  });

  it('should skip rating update for bot games', async () => {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'blitz',
      isBot: true,
    });

    await service.updateRatingsAfterGame(gameId, 'white');

    expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('should store rating before/after in game record', async () => {
    prisma.game.findUniqueOrThrow.mockResolvedValue({
      whiteId,
      blackId,
      timeControlType: 'bullet',
      isBot: false,
    });
    prisma.user.findUniqueOrThrow
      .mockResolvedValueOnce({ ratingBullet: 1400 })
      .mockResolvedValueOnce({ ratingBullet: 1600 });

    await service.updateRatingsAfterGame(gameId, 'white');

    expect(prisma.game.update).toHaveBeenCalledWith({
      where: { id: gameId },
      data: expect.objectContaining({
        whiteRatingBefore: 1400,
        blackRatingBefore: 1600,
        whiteRatingAfter: expect.any(Number),
        blackRatingAfter: expect.any(Number),
      }),
    });
  });

  it('should use correct rating field per time control type', async () => {
    for (const tc of ['bullet', 'blitz', 'rapid', 'classical']) {
      prisma.game.findUniqueOrThrow.mockResolvedValue({
        whiteId,
        blackId,
        timeControlType: tc,
        isBot: false,
      });
      const ratingField = `rating${tc.charAt(0).toUpperCase() + tc.slice(1)}`;
      prisma.user.findUniqueOrThrow
        .mockResolvedValueOnce({ [ratingField]: 1500 })
        .mockResolvedValueOnce({ [ratingField]: 1500 });

      await service.updateRatingsAfterGame(gameId, 'draw');

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { [ratingField]: expect.any(Number) },
        }),
      );
    }
  });
});
