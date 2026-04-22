import { NotFoundException } from '@nestjs/common';
import { BroadcastController } from './broadcast.controller';

/**
 * Минимальный unit-test для BroadcastController:
 *   - `GET /` возвращает пустой список при пустой БД.
 *   - `GET /:id` кидает 404 при отсутствии записи.
 *
 * Пути без префикса `/broadcasts` — KS-1702, субдомен
 * `broadcasts.kingside.site` уже выражает домен.
 *
 * Больший coverage (standings crosstable, pinned stats) — e2e-уровень, его
 * добавим после того как broadcasts_kingside БД будет доступна в CI.
 */
describe('BroadcastController', () => {
  function build(prismaOverrides: Record<string, unknown> = {}) {
    const prisma = {
      broadcast: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      broadcastRound: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      broadcastGame: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      ...prismaOverrides,
    };
    const controller = new BroadcastController(prisma as never);
    return { controller, prisma };
  }

  it('GET / — empty DB → { data: [], total: 0 }', async () => {
    const { controller } = build();
    const res = await controller.getActiveBroadcasts();
    expect(res).toEqual({ data: [], total: 0, limit: 20, offset: 0 });
  });

  it('GET /:id — 404 when missing', async () => {
    const { controller } = build();
    await expect(controller.getBroadcast('11111111-1111-1111-1111-111111111111')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // KS-1702 hotfix: жадный `:id`-матчинг уводил legacy `/broadcasts` и
  // monitoring `/active` в Prisma.findUnique → 500 на UUID validation.
  // Теперь assertUuid в контроллере отдаёт 404 до обращения в БД.
  describe('non-UUID :id → 404 (hotfix после acad49ec)', () => {
    it.each([
      ['broadcasts'], // legacy-фронт на старом префиксе
      ['active'],     // внешний monitoring/бот
      ['not-a-uuid'],
      [''],
      ['12345'],
    ])('getBroadcast(%p) → NotFoundException без обращения в БД', async (id) => {
      const { controller, prisma } = build();
      await expect(controller.getBroadcast(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.broadcast.findUnique).not.toHaveBeenCalled();
    });

    it('getBroadcastRounds("broadcasts") → 404 без БД', async () => {
      const { controller, prisma } = build();
      await expect(controller.getBroadcastRounds('broadcasts')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.broadcast.findUnique).not.toHaveBeenCalled();
    });

    it('getStandings("active") → 404 без БД', async () => {
      const { controller, prisma } = build();
      await expect(controller.getStandings('active')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.broadcast.findUnique).not.toHaveBeenCalled();
    });

    it('getBroadcastRoundGames(non-UUID, uuid) → 404 без БД', async () => {
      const { controller, prisma } = build();
      await expect(
        controller.getBroadcastRoundGames('garbage', '11111111-1111-1111-1111-111111111111'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.broadcastRound.findFirst).not.toHaveBeenCalled();
    });

    it('getBroadcastRoundGames(uuid, non-UUID roundId) → 404 без БД', async () => {
      const { controller, prisma } = build();
      await expect(
        controller.getBroadcastRoundGames('11111111-1111-1111-1111-111111111111', 'garbage'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.broadcastRound.findFirst).not.toHaveBeenCalled();
    });
  });
});
