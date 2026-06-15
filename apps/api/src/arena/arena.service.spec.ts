import { NotFoundException } from '@nestjs/common';
import { ArenaService } from './arena.service';

describe('ArenaService', () => {
  let service: ArenaService;
  let prisma: Record<string, any>;
  let redis: Record<string, any>;
  let gameService: Record<string, any>;
  // KS-4205: ссылка на мок prerender для проверки в hooks-тестах.
  let prerenderMock: {
    enqueueFireAndForget: jest.Mock;
    enqueueBatchFireAndForget: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      arenaTournament: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
        delete: jest.fn(),
      },
      arenaTournamentEntry: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      tournamentPairing: { findMany: jest.fn().mockResolvedValue([]) },
      tournamentInvite: { upsert: jest.fn() },
      game: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      user: {
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    redis = {
      zrangebyscore: jest.fn().mockResolvedValue([]),
      zadd: jest.fn(),
      zrem: jest.fn(),
      zrange: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      del: jest.fn(),
    };
    gameService = { initGame: jest.fn() };
    prerenderMock = {
      enqueueFireAndForget: jest.fn(),
      enqueueBatchFireAndForget: jest.fn(),
    };
    service = new ArenaService(
      prisma as any,
      redis as any,
      gameService as any,
      // KS-4205: PrerenderEnqueueService — мок, проверяется в hooks-test.
      prerenderMock as any,
    );
  });

  it('should reject duration outside 1-180 range', async () => {
    await expect(service.create('u1', {
      name: 'Test', timeInitialSec: 180, timeIncrementSec: 0,
      durationMin: 0, startsAt: new Date(Date.now() + 60000).toISOString(),
    })).rejects.toThrow('Duration must be 1-180 minutes');

    await expect(service.create('u1', {
      name: 'Test', timeInitialSec: 180, timeIncrementSec: 0,
      durationMin: 181, startsAt: new Date(Date.now() + 60000).toISOString(),
    })).rejects.toThrow('Duration must be 1-180 minutes');
  });

  it('should reject past start time', async () => {
    await expect(service.create('u1', {
      name: 'Test', timeInitialSec: 180, timeIncrementSec: 0,
      durationMin: 60, startsAt: '2020-01-01T00:00:00Z',
    })).rejects.toThrow('Start time must be in the future');
  });

  it('should add score with streak bonus', async () => {
    prisma.game.findUnique.mockResolvedValue({
      tournamentId: 't1', whiteId: 'w', blackId: 'b', result: 'white',
      whiteBerserk: false, blackBerserk: false,
    });
    prisma.arenaTournament.findUnique.mockResolvedValue({ id: 't1', type: 'arena' });
    prisma.arenaTournamentEntry.findUnique
      .mockResolvedValueOnce({ id: 'e1', streak: 1 }) // winner: streak 1 -> 2 (bonus)
      .mockResolvedValueOnce({ id: 'e2', streak: 0 }); // loser

    await service.onGameFinished('g1');

    // Winner: streak >= 2, so 4 points
    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e1' },
        data: expect.objectContaining({ score: { increment: 4 }, streak: 2 }),
      }),
    );
    // Loser: 0 points
    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e2' },
        data: expect.objectContaining({ score: { increment: 0 }, streak: 0 }),
      }),
    );
  });

  it('should give 1 point each on draw', async () => {
    prisma.game.findUnique.mockResolvedValue({
      tournamentId: 't1', whiteId: 'w', blackId: 'b', result: 'draw',
      whiteBerserk: false, blackBerserk: false,
    });
    prisma.arenaTournament.findUnique.mockResolvedValue({ id: 't1', type: 'arena' });
    prisma.arenaTournamentEntry.findUnique
      .mockResolvedValueOnce({ id: 'e1', streak: 0 })
      .mockResolvedValueOnce({ id: 'e2', streak: 3 });

    await service.onGameFinished('g1');

    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledTimes(2);
    // Both get 1 point, streak resets
    expect(prisma.arenaTournamentEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ score: { increment: 1 }, streak: 0 }) }),
    );
  });

  // ── KS-2256 (ADR-036 §3.4): hidden-аккаунты не показываем в публичных
  // standings/crosstable/invite. Нужно убедиться, что соответствующие
  // запросы фильтруют через nested-where `user: { isHidden: false }`.
  describe('KS-2256: isHidden filter в публичных endpoints', () => {
    it('getStandings: entries запрашиваются с user.isHidden=false', async () => {
      prisma.arenaTournament.findUnique.mockResolvedValue({
        id: 't1',
        type: 'arena',
        pointsWin: 1,
        pointsDraw: 0,
        pointsLoss: 0,
      });
      prisma.arenaTournamentEntry.findMany.mockResolvedValue([]);
      prisma.game.findMany.mockResolvedValue([]);

      await service.getStandings('t1');

      expect(prisma.arenaTournamentEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tournamentId: 't1',
            user: { isHidden: false },
          }),
        }),
      );
    });

    it('getCrosstable: entries запрашиваются с user.isHidden=false', async () => {
      prisma.arenaTournament.findUnique.mockResolvedValue({ id: 't1', type: 'swiss' });
      prisma.arenaTournamentEntry.findMany.mockResolvedValue([]);
      prisma.tournamentPairing.findMany.mockResolvedValue([]);

      await service.getCrosstable('t1');

      expect(prisma.arenaTournamentEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tournamentId: 't1',
            user: { isHidden: false },
          }),
        }),
      );
    });

    it('invitePlayer: hidden-аккаунт не находится → 404', async () => {
      prisma.arenaTournament.findUnique.mockResolvedValue({
        id: 't1',
        createdBy: 'creator',
      });
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.invitePlayer('t1', 'hiddenuser', 'creator'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ username: 'hiddenuser', isHidden: false }),
        }),
      );
    });
  });

  // KS-4205 / ADR-128 §10 #11 §7.3.7: prerender enqueue при досрочном
  // завершении турнира через withdraw → finishTournamentEarly. Hook на
  // естественном завершении (RoundManagerService.finalizeRound) покрыт
  // отдельно — там нет unit-spec'а, проверяется на интеграционном
  // прогоне tournament-flow.
  describe('KS-4205: prerender hook на finishTournamentEarly', () => {
    beforeEach(() => {
      // Доукомплектовываем prisma-мок методами, которые `withdraw`
      // дёргает в auto-finish ветке.
      prisma.tournamentRound = {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      };
      prisma.arenaTournamentEntry.count = jest.fn().mockResolvedValue(0);
      prisma.game.findFirst = jest.fn().mockResolvedValue(null);
    });

    it('withdraw в swiss с <=1 оставшимся → finishTournamentEarly → enqueue tournament + list', async () => {
      prisma.arenaTournament.findUnique.mockResolvedValue({
        id: 't-fin-1',
        type: 'swiss',
        status: 'active',
      });
      prisma.arenaTournamentEntry.findUnique.mockResolvedValue({
        id: 'e-1',
        userId: 'u-1',
        tournamentId: 't-fin-1',
        withdrawn: false,
      });
      prisma.arenaTournamentEntry.count.mockResolvedValue(0); // никого не осталось
      prisma.arenaTournament.update.mockResolvedValue({});
      prisma.game.findMany.mockResolvedValue([]);

      await service.leave('t-fin-1', 'u-1');

      expect(prerenderMock.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'tournament',
        id: 't-fin-1',
      });
      expect(prerenderMock.enqueueFireAndForget).toHaveBeenCalledWith({
        kind: 'list',
        route: '/tournaments',
      });
    });

    it('withdraw в активной арене с активными игроками — НЕ дёргает prerender', async () => {
      prisma.arenaTournament.findUnique.mockResolvedValue({
        id: 't-still-1',
        type: 'arena',
        status: 'active',
      });
      prisma.arenaTournamentEntry.findUnique.mockResolvedValue({
        id: 'e-2',
        userId: 'u-2',
        tournamentId: 't-still-1',
        withdrawn: false,
      });
      prisma.arenaTournamentEntry.count.mockResolvedValue(5); // ещё играют

      await service.leave('t-still-1', 'u-2');

      expect(prerenderMock.enqueueFireAndForget).not.toHaveBeenCalled();
    });
  });
});
