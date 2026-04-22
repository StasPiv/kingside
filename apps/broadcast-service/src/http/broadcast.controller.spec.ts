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

  // KS-1700 Part B: lifecycleStatus + сортировка + фильтр ?lifecycle
  describe('GET / — lifecycleStatus + сортировка (KS-1700 Part B)', () => {
    // Три broadcast'а разных lifecycle — проверяем и поле, и порядок.
    const now = Date.now();
    const upcomingSoon = new Date(now + 72 * 3600 * 1000); // +72h
    const upcomingLate = new Date(now + 168 * 3600 * 1000); // +7d

    const broadcastsFixture = [
      {
        id: 'uuid-finished',
        lichessId: 'lf',
        title: 'Finished Old',
        isActive: true,
        startDate: new Date(now - 14 * 86400 * 1000),
        updatedAt: new Date(now - 3 * 86400 * 1000),
        _count: { rounds: 3 },
      },
      {
        id: 'uuid-live',
        lichessId: 'll',
        title: 'Live Now',
        isActive: true,
        startDate: new Date(now - 86400 * 1000),
        updatedAt: new Date(now - 60 * 1000),
        _count: { rounds: 5 },
      },
      {
        id: 'uuid-upcoming-late',
        lichessId: 'lul',
        title: 'Upcoming in a week',
        isActive: true,
        startDate: upcomingLate,
        updatedAt: new Date(now - 2 * 86400 * 1000),
        _count: { rounds: 4 },
      },
      {
        id: 'uuid-upcoming-soon',
        lichessId: 'lus',
        title: 'Upcoming in 3 days',
        isActive: true,
        startDate: upcomingSoon,
        updatedAt: new Date(now - 4 * 86400 * 1000),
        _count: { rounds: 4 },
      },
    ];

    // Возвращаем $queryRaw строки с соответствующим lifecycle-сигналом.
    const queryRawRows = [
      {
        id: 'uuid-finished',
        has_live: false,
        has_upcoming: false,
        nearest_pending_at: null,
        avg_elo: 2400,
        elo_games_count: 10,
      },
      {
        id: 'uuid-live',
        has_live: true,
        has_upcoming: false,
        nearest_pending_at: null,
        avg_elo: 2750,
        elo_games_count: 10,
      },
      {
        id: 'uuid-upcoming-late',
        has_live: false,
        has_upcoming: true,
        nearest_pending_at: upcomingLate,
        avg_elo: null,
        elo_games_count: 0,
      },
      {
        id: 'uuid-upcoming-soon',
        has_live: false,
        has_upcoming: true,
        nearest_pending_at: upcomingSoon,
        avg_elo: null,
        elo_games_count: 0,
      },
    ];

    function buildWithFixture() {
      return build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue(broadcastsFixture),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(broadcastsFixture.length),
        },
        $queryRaw: jest.fn().mockResolvedValue(queryRawRows),
      });
    }

    it('каждый элемент содержит lifecycleStatus', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0');
      const byId = new Map(res.data.map((d) => [d.id, d.lifecycleStatus]));
      expect(byId.get('uuid-live')).toBe('live');
      expect(byId.get('uuid-upcoming-soon')).toBe('upcoming');
      expect(byId.get('uuid-upcoming-late')).toBe('upcoming');
      expect(byId.get('uuid-finished')).toBe('finished');
    });

    it('сортировка: live → upcoming (по ближайшему старту) → finished', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0');
      expect(res.data.map((d) => d.id)).toEqual([
        'uuid-live',
        'uuid-upcoming-soon', // +72h
        'uuid-upcoming-late', // +168h
        'uuid-finished',
      ]);
    });

    it('isPinned=true возможен только при lifecycleStatus=live', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0');
      const byId = new Map(res.data.map((d) => [d.id, d]));
      // Live с сильным полем → pinned
      expect(byId.get('uuid-live')!.isPinned).toBe(true);
      // finished/upcoming всегда isPinned=false
      expect(byId.get('uuid-finished')!.isPinned).toBe(false);
      expect(byId.get('uuid-upcoming-soon')!.isPinned).toBe(false);
    });

    it('?lifecycle=live возвращает только live', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0', 'live');
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe('uuid-live');
      expect(res.total).toBe(1);
    });

    it('?lifecycle=upcoming возвращает только upcoming с порядком по ближайшему старту', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0', 'upcoming');
      expect(res.data.map((d) => d.id)).toEqual([
        'uuid-upcoming-soon',
        'uuid-upcoming-late',
      ]);
      expect(res.total).toBe(2);
    });

    it('?lifecycle=finished возвращает только finished', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0', 'finished');
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe('uuid-finished');
    });

    it('?lifecycle=garbage трактуется как all (default)', async () => {
      const { controller } = buildWithFixture();
      const res = await controller.getActiveBroadcasts('100', '0', 'garbage');
      expect(res.data).toHaveLength(4);
    });

    it('пагинация применяется ПОСЛЕ фильтра + сортировки', async () => {
      const { controller } = buildWithFixture();
      // total=4 по all, limit=2 offset=1 → вторая и третья запись по sorted order.
      const res = await controller.getActiveBroadcasts('2', '1');
      expect(res.total).toBe(4);
      expect(res.limit).toBe(2);
      expect(res.offset).toBe(1);
      expect(res.data.map((d) => d.id)).toEqual([
        'uuid-upcoming-soon',
        'uuid-upcoming-late',
      ]);
    });

    it('broadcast без detail-строки (не в $queryRaw) дефолтится в finished', async () => {
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([broadcastsFixture[1]]), // live fixture
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([]), // пустой detail
      });
      const res = await controller.getActiveBroadcasts();
      expect(res.data).toHaveLength(1);
      expect(res.data[0].lifecycleStatus).toBe('finished');
      expect(res.data[0].isPinned).toBe(false);
    });
  });
});
