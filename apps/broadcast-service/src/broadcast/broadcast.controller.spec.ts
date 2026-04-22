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
});
