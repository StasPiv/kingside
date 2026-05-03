import { TournamentService } from './tournament.service';

describe('TournamentService', () => {
  let service: TournamentService;
  let prisma: {
    game: { findMany: jest.Mock };
    liveTournament: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      game: { findMany: jest.fn() },
      liveTournament: { findMany: jest.fn() },
    };
    service = new TournamentService(prisma as any);
  });

  describe('getTopActiveTournaments', () => {
    it('should return 3 mock tournaments', async () => {
      prisma.game.findMany.mockResolvedValue([]);

      const result = await service.getTopActiveTournaments();

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('Daily Blitz Arena');
      expect(result[1].name).toBe('Weekly Rapid Open');
      expect(result[2].name).toBe('Bullet Madness');
    });

    it('should populate topGames from active games', async () => {
      prisma.game.findMany.mockResolvedValue([
        {
          id: 'g1',
          pgn: null,
          finalFen: null,
          timeControlType: 'blitz',
          timeInitialSec: 180,
          timeIncrementSec: 2,
          white: { id: 'w1', username: 'Alice', ratingBlitz: 1500, ratingRapid: 1400, ratingBullet: 1300 },
          black: { id: 'b1', username: 'Bob', ratingBlitz: 1600, ratingRapid: 1500, ratingBullet: 1400 },
        },
      ]);

      const result = await service.getTopActiveTournaments();

      expect(result[0].topGames).toHaveLength(1);
      expect(result[0].topGames[0].whitePlayer.username).toBe('Alice');
      expect(result[0].topGames[0].whitePlayer.rating).toBe(1500);
    });

    it('should return 0 active players when no games', async () => {
      prisma.game.findMany.mockResolvedValue([]);

      const result = await service.getTopActiveTournaments();

      expect(result[0].activePlayers).toBe(0);
    });

    // KS-2256 (ADR-036 §3.4): партии с участием hidden-аккаунта не
    // должны попадать в публичный «top active games» список.
    it('KS-2256: фильтрует игры hidden-игроков (white/black.isHidden=false)', async () => {
      prisma.game.findMany.mockResolvedValue([]);

      await service.getTopActiveTournaments();

      expect(prisma.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'active',
            white: { isHidden: false },
            black: { isHidden: false },
          }),
        }),
      );
    });
  });

  describe('getLiveTournaments', () => {
    it('should return all tournaments when no filter', async () => {
      const now = new Date();
      prisma.liveTournament.findMany.mockResolvedValue([
        { id: 't1', name: 'T1', status: 'live', createdAt: now, updatedAt: now },
      ]);

      const result = await service.getLiveTournaments();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('T1');
    });

    it('should filter by status', async () => {
      prisma.liveTournament.findMany.mockResolvedValue([]);

      await service.getLiveTournaments('live');

      expect(prisma.liveTournament.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'live' },
        }),
      );
    });

    it('should not filter when status is "all"', async () => {
      prisma.liveTournament.findMany.mockResolvedValue([]);

      await service.getLiveTournaments('all');

      expect(prisma.liveTournament.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('should convert dates to ISO strings', async () => {
      const now = new Date('2026-03-22T10:00:00Z');
      prisma.liveTournament.findMany.mockResolvedValue([
        { id: 't1', name: 'T1', createdAt: now, updatedAt: now },
      ]);

      const result = await service.getLiveTournaments();

      expect(result.data[0].createdAt).toBe('2026-03-22T10:00:00.000Z');
    });
  });
});
