import { NotFoundException } from '@nestjs/common';
import {
  BroadcastController,
  avgEloOfTopN,
  buildTopPlayers,
  deduplicateGamesByPair,
} from './broadcast.controller';

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
  function build(
    prismaOverrides: Record<string, unknown> = {},
    standingsSyncOverrides: Partial<{ getFresh: jest.Mock }> = {},
  ) {
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
    const standingsSync = {
      getFresh:
        standingsSyncOverrides.getFresh ??
        jest.fn().mockResolvedValue({
          tournamentType: 'unknown',
          sourceType: 'internal-fallback',
          sourceUrl: null,
          fetchedAt: null,
          players: [],
          reason: 'default mock',
        }),
    };
    const controller = new BroadcastController(
      prisma as never,
      standingsSync as never,
    );
    return { controller, prisma, standingsSync };
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
    // Поля совпадают с контроллерным SQL: end_date_passed / first_round_started /
    // has_active_rounds (KS-2514).
    const queryRawRows = [
      {
        id: 'uuid-finished',
        end_date_passed: true,
        first_round_started: true,
        has_active_rounds: false,
        all_rounds_finished: true,
        has_live_round: false,
        nearest_pending_at: null,
        avg_elo: 2400,
        elo_games_count: 10,
      },
      {
        id: 'uuid-live',
        end_date_passed: false,
        first_round_started: true,
        has_active_rounds: true,
        all_rounds_finished: false,
        has_live_round: true,
        nearest_pending_at: null,
        avg_elo: 2750,
        elo_games_count: 10,
      },
      {
        id: 'uuid-upcoming-late',
        end_date_passed: false,
        first_round_started: false,
        has_active_rounds: false,
        all_rounds_finished: false,
        has_live_round: true,
        nearest_pending_at: upcomingLate,
        avg_elo: null,
        elo_games_count: 0,
      },
      {
        id: 'uuid-upcoming-soon',
        end_date_passed: false,
        first_round_started: false,
        has_active_rounds: false,
        all_rounds_finished: false,
        has_live_round: true,
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

    it('KS-2514: end_date_passed но has_active_rounds → live (Sigeman last round ongoing)', async () => {
      // Регрессия: Lichess ставит end_date = время начала последнего
      // тура (а не окончания партий). Раунд ongoing, но end_date <
      // NOW() → старая логика выдавала finished. Теперь
      // has_active_rounds=true перебивает end_date_passed.
      const sigemanLike = {
        id: 'uuid-sigeman',
        lichessId: 'sig',
        title: 'TePe Sigeman & Co Chess Tournament 2026',
        isActive: true,
        startDate: new Date(now - 6 * 86400 * 1000),
        updatedAt: new Date(now - 1000),
        _count: { rounds: 7 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([sigemanLike]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-sigeman',
            end_date_passed: true,
            first_round_started: true,
            has_active_rounds: true, // Round 7 ongoing
            all_rounds_finished: false,
            has_live_round: true, // ongoing round
            nearest_pending_at: null,
            avg_elo: 2750,
            elo_games_count: 30,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data).toHaveLength(1);
      expect(res.data[0].lifecycleStatus).toBe('live');
      expect(res.data[0].isPinned).toBe(true); // strong field, live
    });

    it('KS-2592: все раунды finished → lifecycle=finished, даже если end_date IS NULL (TCEC)', async () => {
      // Регрессия: TCEC и подобные движковые турниры приходят с
      // Lichess без `end_date`. Старая логика требовала end_date_passed,
      // и при NULL → end_date_passed=false → турнир навечно оставался
      // в `live` после закрытия всех раундов. Новая ветка
      // `all_rounds_finished` ловит этот кейс независимо от end_date.
      const tcecLike = {
        id: 'uuid-tcec',
        lichessId: 'tcec1',
        title: 'TCEC Double Fischer Random Chess 5 | League A',
        isActive: false,
        startDate: null,
        updatedAt: new Date(now - 3 * 86400 * 1000),
        _count: { rounds: 14 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([tcecLike]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-tcec',
            end_date_passed: false, // end_date IS NULL
            first_round_started: true,
            has_active_rounds: false,
            all_rounds_finished: true, // ключевой сигнал
            has_live_round: false,
            nearest_pending_at: null,
            avg_elo: 3600,
            elo_games_count: 56,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data).toHaveLength(1);
      expect(res.data[0].lifecycleStatus).toBe('finished');
      expect(res.data[0].isPinned).toBe(false);
    });

    it('KS-2592: all_rounds_finished=false и нет активных раундов → не finished (защита от пустого броадкаста)', async () => {
      // Защитный кейс: если в броадкасте нет раундов вообще (пустой —
      // например, только что создан), `all_rounds_finished=false`
      // (vacuous truth не срабатывает благодаря явному EXISTS).
      // Турнир должен быть `upcoming`, не `finished`.
      const empty = {
        id: 'uuid-empty',
        lichessId: 'empty',
        title: 'Just created',
        isActive: true,
        startDate: null,
        updatedAt: new Date(now - 1000),
        _count: { rounds: 0 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([empty]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-empty',
            end_date_passed: false,
            first_round_started: false, // guard: не стартовал
            has_active_rounds: false,
            all_rounds_finished: false, // нет раундов вообще
            has_live_round: false, // KS-3384: но first_round_started=false → upcoming
            nearest_pending_at: null,
            avg_elo: null,
            elo_games_count: 0,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data[0].lifecycleStatus).toBe('upcoming');
    });

    it('KS-3384: «вечный LIVE» — стартовавший турнир с несыгранными pending-раундами → finished', async () => {
      // DreamHack-кейс: турнир завершился, но Lichess создал
      // never-played pending-раунды (Armageddon / второй пайт) и не
      // отдал end_date. end_date_passed=false, all_rounds_finished=false
      // (pending ≠ finished), но has_live_round=false (нет ongoing и
      // нет pending в обозримом окне). first_round_started=true.
      const stuckBroadcast = {
        id: 'uuid-stuck',
        lichessId: 'dreamhack-gsb',
        title: 'DreamHack Atlanta 2026 | Group Stage B | Lower Bracket',
        isActive: false,
        startDate: new Date(now - 10 * 86400 * 1000),
        updatedAt: new Date(now - 8 * 86400 * 1000),
        _count: { rounds: 12 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([stuckBroadcast]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-stuck',
            end_date_passed: false, // end_date IS NULL
            first_round_started: true,
            has_active_rounds: false,
            all_rounds_finished: false, // pending Armageddon ≠ finished
            has_live_round: false, // ключевой сигнал KS-3384
            nearest_pending_at: null,
            avg_elo: 2666,
            elo_games_count: 30,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data[0].lifecycleStatus).toBe('finished');
      expect(res.data[0].isPinned).toBe(false);
    });

    it('KS-3384: реально идущий турнир (pending-раунд скоро стартует) остаётся live', async () => {
      // Между раундами: текущий ongoing закрыт, следующий pending со
      // стартом в обозримом окне → has_live_round=true → live.
      const liveBroadcast = {
        id: 'uuid-live-between',
        lichessId: 'norway',
        title: 'Norway Chess 2026',
        isActive: true,
        startDate: new Date(now - 2 * 86400 * 1000),
        updatedAt: new Date(now - 1000),
        _count: { rounds: 9 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([liveBroadcast]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-live-between',
            end_date_passed: false,
            first_round_started: true,
            has_active_rounds: true,
            all_rounds_finished: false,
            has_live_round: true, // следующий pending скоро
            nearest_pending_at: null,
            avg_elo: 2800,
            elo_games_count: 20,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data[0].lifecycleStatus).toBe('live');
    });

    it('KS-3384: пустой свежесозданный broadcast (0 раундов, has_live_round=false) → upcoming, НЕ finished', async () => {
      // Guard `first_round_started`: третье правило НЕ должно ронять
      // ещё не стартовавший broadcast в finished.
      const fresh = {
        id: 'uuid-fresh',
        lichessId: 'fresh',
        title: 'Just announced',
        isActive: true,
        startDate: null,
        updatedAt: new Date(now - 1000),
        _count: { rounds: 0 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([fresh]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-fresh',
            end_date_passed: false,
            first_round_started: false, // не стартовал → guard
            has_active_rounds: false,
            all_rounds_finished: false,
            has_live_round: false,
            nearest_pending_at: null,
            avg_elo: null,
            elo_games_count: 0,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data[0].lifecycleStatus).toBe('upcoming');
    });

    it('KS-2514: end_date_passed и нет активных раундов → finished (старое поведение)', async () => {
      const finishedBroadcast = {
        id: 'uuid-actually-finished',
        lichessId: 'fin',
        title: 'Done Tournament',
        isActive: true,
        startDate: new Date(now - 30 * 86400 * 1000),
        updatedAt: new Date(now - 86400 * 1000),
        _count: { rounds: 9 },
      };
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([finishedBroadcast]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-actually-finished',
            end_date_passed: true,
            first_round_started: true,
            has_active_rounds: false,
            all_rounds_finished: true,
            has_live_round: false,
            nearest_pending_at: null,
            avg_elo: 2700,
            elo_games_count: 50,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();
      expect(res.data[0].lifecycleStatus).toBe('finished');
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

    it('KS-1746: archived broadcast (isActive=false) виден в /broadcasts как finished', async () => {
      // Регрессия: до фикса controller фильтровал `where: { isActive: true }`,
      // и архив (помеченный stale-check после 72 циклов) пропадал с фронта,
      // хотя в БД оставался. Сейчас он возвращается с lifecycleStatus='finished'
      // и status='finished'.
      const archivedBroadcast = {
        id: 'uuid-archived',
        lichessId: 'la',
        title: 'Archived Tournament',
        isActive: false, // помечен stale-check'ом
        startDate: new Date(now - 30 * 86400 * 1000),
        updatedAt: new Date(now - 10 * 86400 * 1000),
        _count: { rounds: 9 },
      };
      const findManyMock = jest.fn().mockResolvedValue([archivedBroadcast]);
      const { controller, prisma } = build({
        broadcast: {
          findMany: findManyMock,
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(1),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-archived',
            end_date_passed: true,
            first_round_started: true,
            has_active_rounds: false,
            all_rounds_finished: true,
            has_live_round: false,
            nearest_pending_at: null,
            avg_elo: 2700,
            elo_games_count: 50,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts();

      // 1. archived broadcast в выдаче.
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe('uuid-archived');
      // 2. status='finished' (не 'active').
      expect(res.data[0].status).toBe('finished');
      // 3. lifecycleStatus='finished' (нет ongoing/pending rounds).
      expect(res.data[0].lifecycleStatus).toBe('finished');
      // 4. isPinned=false для archived.
      expect(res.data[0].isPinned).toBe(false);

      // 5. КЛЮЧЕВОЕ — `where.isActive` НЕ выставлен в findMany (KS-1746).
      // KS-2207 добавил where.rounds для фильтра по партиям — это ок.
      const findManyCall = findManyMock.mock.calls[0][0];
      expect(findManyCall.where?.isActive).toBeUndefined();
      void prisma;
    });

    it('KS-1746: archived broadcast виден и при lifecycle=finished фильтре', async () => {
      const archived = {
        id: 'uuid-archived-2',
        lichessId: 'la2',
        title: 'Old Archive',
        isActive: false,
        startDate: new Date(now - 60 * 86400 * 1000),
        updatedAt: new Date(now - 30 * 86400 * 1000),
        _count: { rounds: 5 },
      };
      const live = broadcastsFixture[1]; // активный live
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([archived, live]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(2),
        },
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'uuid-archived-2',
            end_date_passed: true,
            first_round_started: true,
            has_active_rounds: false,
            all_rounds_finished: true,
            has_live_round: false,
            nearest_pending_at: null,
            avg_elo: 2400,
            elo_games_count: 10,
          },
          {
            id: 'uuid-live',
            end_date_passed: false,
            first_round_started: true,
            has_active_rounds: true,
            all_rounds_finished: false,
            has_live_round: true,
            nearest_pending_at: null,
            avg_elo: 2750,
            elo_games_count: 10,
          },
        ]),
      });

      const res = await controller.getActiveBroadcasts(
        undefined,
        undefined,
        'finished',
      );
      // Только archived попал в finished-фильтр (live → live, отсеян).
      expect(res.data.map((d) => d.id)).toEqual(['uuid-archived-2']);
    });
  });

  describe('GET /:id/crosstable (KS-1734)', () => {
    const validId = '11111111-1111-1111-1111-111111111111';

    it('happy path: делегирует в standingsSync.getFresh, возвращает CrosstableResponse', async () => {
      const fakeResp = {
        tournamentType: 'round-robin' as const,
        sourceType: 'chess-results' as const,
        sourceUrl: 'https://chess-results.com/tnr1.aspx',
        fetchedAt: '2026-04-23T12:00:00.000Z',
        players: [
          {
            rank: 1,
            name: 'Player A',
            normalizedName: 'player a',
            points: 5,
            gamesPlayed: 5,
          },
        ],
        matrix: [[{ result: null }]],
      };
      const { controller, standingsSync } = build(
        {},
        { getFresh: jest.fn().mockResolvedValue(fakeResp) },
      );
      const res = await controller.getCrosstable(validId);
      expect(res).toEqual(fakeResp);
      expect(standingsSync.getFresh).toHaveBeenCalledWith(validId);
    });

    it('non-UUID :id → 404 без обращения в sync (assertUuid)', async () => {
      const { controller, standingsSync } = build();
      await expect(controller.getCrosstable('not-a-uuid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(standingsSync.getFresh).not.toHaveBeenCalled();
    });

    it('sync-сервис бросает "not found" → 404 (broadcast не существует)', async () => {
      const { controller } = build(
        {},
        {
          getFresh: jest
            .fn()
            .mockRejectedValue(new Error('broadcast bc-1 not found')),
        },
      );
      await expect(controller.getCrosstable(validId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('sync-сервис бросает другую ошибку → пробрасывается как есть (500)', async () => {
      const otherErr = new Error('database connection lost');
      const { controller } = build(
        {},
        { getFresh: jest.fn().mockRejectedValue(otherErr) },
      );
      await expect(controller.getCrosstable(validId)).rejects.toThrow(
        /database connection lost/,
      );
    });
  });

  // ── KS-1824: GET /:id/bracket — агрегированная сетка плей-офф ────

  describe('GET /:id/bracket', () => {
    const broadcastId = '11111111-1111-1111-1111-111111111111';

    function bracketBuild(rounds: unknown[]) {
      return build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue({ id: broadcastId }),
          count: jest.fn().mockResolvedValue(0),
        },
        broadcastRound: {
          findMany: jest.fn().mockResolvedValue(rounds),
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      });
    }

    it('404 когда broadcast не найден', async () => {
      const { controller } = build({
        broadcast: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
      });
      await expect(controller.getBroadcastBracket(broadcastId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404 на не-UUID (assertUuid отбивает до БД)', async () => {
      const { controller, prisma } = build();
      await expect(controller.getBroadcastBracket('not-a-uuid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.broadcast.findUnique).not.toHaveBeenCalled();
    });

    it('playoff-раунды → tournamentType=playoff, games со всех playoff-раундов с bracket-полями + advance-поля прокинуты, links[] содержит semi→final', async () => {
      const { controller } = bracketBuild([
        {
          id: 'r-sf',
          tournamentType: 'playoff',
          games: [
            {
              id: 'g-sf-1',
              lichessGameId: 'lg1',
              whitePlayer: 'Alice',
              blackPlayer: 'Bob',
              whiteElo: 2700,
              blackElo: 2710,
              result: '1-0',
              pgn: '1. e4',
              currentFen: 'fen1',
              updatedAt: new Date('2026-04-24T08:00:00Z'),
              bracketStage: 'semi',
              bracketPairId: 'semi:alice|bob',
              matchScore: '1-0',
              advanceToPairId: 'final:bob|carol',
              loserToPairId: null,
            },
          ],
        },
        {
          id: 'r-final',
          tournamentType: 'playoff',
          games: [
            {
              id: 'g-final-1',
              lichessGameId: 'lg2',
              whitePlayer: 'Bob',
              blackPlayer: 'Carol',
              whiteElo: 2710,
              blackElo: 2720,
              result: '0-1',
              pgn: '1. d4',
              currentFen: 'fen2',
              updatedAt: new Date('2026-04-24T09:00:00Z'),
              bracketStage: 'final',
              bracketPairId: 'final:bob|carol',
              matchScore: '0-1',
              advanceToPairId: null,
              loserToPairId: null,
            },
          ],
        },
      ]);

      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.broadcastId).toBe(broadcastId);
      expect(res.tournamentType).toBe('playoff');
      expect(res.games).toHaveLength(2);
      expect(res.games[0].bracketStage).toBe('semi');
      expect(res.games[0].bracketPairId).toBe('semi:alice|bob');
      // advanceToPairId прокинут из БД в summary.
      expect(res.games[0].advanceToPairId).toBe('final:bob|carol');
      expect(res.games[1].bracketStage).toBe('final');
      expect(res.games[1].matchScore).toBe('0-1');
      // 1 semi + 1 final: computeAdvanceLinks кладёт одну пару semi
      // в bucket[0] → final-пара на bucket[0]. Результат — одно
      // ребро winner: semi:alice|bob → final:bob|carol.
      expect(res.links).toEqual([
        {
          fromPairId: 'semi:alice|bob',
          toPairId: 'final:bob|carol',
          kind: 'winner',
        },
      ]);
    });

    it('double-elim сетка из winners/losers/grand_final → links[] содержит winner- и loser-рёбра', async () => {
      // 2 winners_quarter → 1 winners_semi → grand_final
      // 2 losers_quarter (пары проигравших) → losers_semi → grand_final
      const games = [
        {
          id: 'g-wq1',
          bracketStage: 'winners_quarter',
          bracketPairId: 'winners_quarter:a|b',
          matchScore: '0-0',
          advanceToPairId: 'winners_semi:ab|cd',
          loserToPairId: 'losers_quarter:p|q',
        },
        {
          id: 'g-wq2',
          bracketStage: 'winners_quarter',
          bracketPairId: 'winners_quarter:c|d',
          matchScore: '0-0',
          advanceToPairId: 'winners_semi:ab|cd',
          loserToPairId: 'losers_quarter:r|s',
        },
        {
          id: 'g-ws',
          bracketStage: 'winners_semi',
          bracketPairId: 'winners_semi:ab|cd',
          matchScore: '0-0',
          advanceToPairId: 'grand_final:f1|f2',
          loserToPairId: null,
        },
        {
          id: 'g-lq1',
          bracketStage: 'losers_quarter',
          bracketPairId: 'losers_quarter:p|q',
          matchScore: '0-0',
          advanceToPairId: 'losers_semi:pq|rs',
          loserToPairId: null,
        },
        {
          id: 'g-lq2',
          bracketStage: 'losers_quarter',
          bracketPairId: 'losers_quarter:r|s',
          matchScore: '0-0',
          advanceToPairId: 'losers_semi:pq|rs',
          loserToPairId: null,
        },
        {
          id: 'g-ls',
          bracketStage: 'losers_semi',
          bracketPairId: 'losers_semi:pq|rs',
          matchScore: '0-0',
          advanceToPairId: 'grand_final:f1|f2',
          loserToPairId: null,
        },
        {
          id: 'g-gf',
          bracketStage: 'grand_final',
          bracketPairId: 'grand_final:f1|f2',
          matchScore: '0-0',
          advanceToPairId: null,
          loserToPairId: null,
        },
      ].map((g) => ({
        lichessGameId: null,
        whitePlayer: null,
        blackPlayer: null,
        whiteElo: null,
        blackElo: null,
        result: null,
        pgn: null,
        currentFen: null,
        updatedAt: new Date('2026-04-24T12:00:00Z'),
        ...g,
      }));

      const { controller } = bracketBuild([
        { id: 'r1', tournamentType: 'playoff', games },
      ]);

      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBe('playoff');
      expect(res.games).toHaveLength(7);
      // Winner-рёбра: QF→SF (2), SF(winners)→GF, QF(losers)→SF(losers) (2), SF(losers)→GF.
      const winnerLinks = res.links.filter((l) => l.kind === 'winner');
      expect(winnerLinks.length).toBeGreaterThanOrEqual(5);
      // Loser-рёбра: 2 winners_quarter → losers_quarter + 1
      // winners_semi → losers_semi (proigравший SF тоже «падает» в
      // losers-сетку по совпадению size). Итого 3.
      const loserLinks = res.links.filter((l) => l.kind === 'loser');
      expect(loserLinks).toHaveLength(3);
      expect(
        loserLinks.some(
          (l) =>
            l.fromPairId === 'winners_quarter:a|b' &&
            l.toPairId === 'losers_quarter:p|q',
        ),
      ).toBe(true);
      expect(
        loserLinks.some(
          (l) =>
            l.fromPairId === 'winners_semi:ab|cd' &&
            l.toPairId === 'losers_semi:pq|rs',
        ),
      ).toBe(true);
    });

    it('гибрид Swiss + Playoffs → только партии playoff-раундов в games[]', async () => {
      const { controller } = bracketBuild([
        {
          id: 'r-swiss',
          tournamentType: 'swiss',
          games: [
            {
              id: 'g-sw',
              lichessGameId: 'lg-sw',
              whitePlayer: 'X',
              blackPlayer: 'Y',
              whiteElo: null,
              blackElo: null,
              result: '1-0',
              pgn: null,
              currentFen: null,
              updatedAt: new Date(),
              bracketStage: null,
              bracketPairId: null,
              matchScore: null,
            },
          ],
        },
        {
          id: 'r-ko',
          tournamentType: 'playoff',
          games: [
            {
              id: 'g-ko',
              lichessGameId: 'lg-ko',
              whitePlayer: 'A',
              blackPlayer: 'B',
              whiteElo: null,
              blackElo: null,
              result: '1-0',
              pgn: null,
              currentFen: null,
              updatedAt: new Date(),
              bracketStage: 'final',
              bracketPairId: 'final:a|b',
              matchScore: '1-0',
            },
          ],
        },
      ]);

      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBe('playoff');
      expect(res.games.map((g) => g.id)).toEqual(['g-ko']);
    });

    it('round-robin броадкаст → tournamentType=round_robin, games=[], links=[]', async () => {
      const { controller } = bracketBuild([
        {
          id: 'r1',
          tournamentType: 'round_robin',
          games: [{ id: 'g1', /* не важно */ updatedAt: new Date() }],
        },
      ]);

      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBe('round_robin');
      expect(res.games).toEqual([]);
      expect(res.links).toEqual([]);
    });

    it('swiss броадкаст → tournamentType=swiss, games=[], links=[]', async () => {
      const { controller } = bracketBuild([
        { id: 'r1', tournamentType: 'swiss', games: [] },
      ]);
      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBe('swiss');
      expect(res.games).toEqual([]);
      expect(res.links).toEqual([]);
    });

    it('все раунды с tournamentType=null → tournamentType=null, games=[], links=[]', async () => {
      const { controller } = bracketBuild([
        { id: 'r1', tournamentType: null, games: [] },
      ]);
      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBeNull();
      expect(res.games).toEqual([]);
      expect(res.links).toEqual([]);
    });

    it('неизвестный tournament_type в БД нормализуется в unknown, links=[]', async () => {
      const { controller } = bracketBuild([
        { id: 'r1', tournamentType: 'garbage', games: [] },
      ]);
      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBe('unknown');
      expect(res.games).toEqual([]);
      expect(res.links).toEqual([]);
    });

    it('нет раундов → tournamentType=null, games=[], links=[]', async () => {
      const { controller } = bracketBuild([]);
      const res = await controller.getBroadcastBracket(broadcastId);
      expect(res.tournamentType).toBeNull();
      expect(res.games).toEqual([]);
      expect(res.links).toEqual([]);
    });
  });
});

// ── KS-2213: deduplicateGamesByPair ─────────────────────────────────────────

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeGame(
  id: string,
  white: string | null,
  black: string | null,
  opts: {
    result?: string | null;
    fen?: string | null;
    updatedAt?: Date;
  } = {},
) {
  return {
    id,
    whitePlayer: white,
    blackPlayer: black,
    result: opts.result ?? '*',
    currentFen: opts.fen ?? STARTING_FEN,
    updatedAt: opts.updatedAt ?? new Date('2026-05-01T12:00:00Z'),
  };
}

describe('deduplicateGamesByPair (KS-2213)', () => {
  it('уникальные пары не трогаем', () => {
    const games = [
      makeGame('g1', 'Carlsen', 'Nakamura'),
      makeGame('g2', 'Fabi', 'Ding'),
    ];
    const out = deduplicateGamesByPair(games);
    expect(out).toHaveLength(2);
  });

  it('два placeholder — оставляем более позднее updatedAt', () => {
    const older = makeGame('old', 'Carlsen', 'Nakamura', {
      updatedAt: new Date('2026-05-01T10:00:00Z'),
    });
    const newer = makeGame('new', 'Carlsen', 'Nakamura', {
      updatedAt: new Date('2026-05-01T14:00:00Z'),
    });
    const out = deduplicateGamesByPair([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('new');
  });

  it('placeholder + реальная (result≠*) → оставляем реальную', () => {
    const placeholder = makeGame('ph', 'Carlsen', 'Nakamura', {
      result: '*',
      fen: STARTING_FEN,
    });
    const real = makeGame('real', 'Carlsen', 'Nakamura', {
      result: '1-0',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      updatedAt: new Date('2026-05-02T10:00:00Z'),
    });
    const out = deduplicateGamesByPair([placeholder, real]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('real');
  });

  it('реальная партия имеет ходы (FEN≠STARTING) — приоритет над placeholder без ходов', () => {
    const placeholder = makeGame('ph', 'A', 'B', {
      result: '*',
      fen: STARTING_FEN,
    });
    const withMoves = makeGame('mv', 'A', 'B', {
      result: '*',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      updatedAt: new Date('2026-05-01T11:00:00Z'),
    });
    const out = deduplicateGamesByPair([placeholder, withMoves]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('mv');
  });

  it('порядок (white/black) не важен — пары нормализуются', () => {
    const g1 = makeGame('g1', 'Carlsen', 'Nakamura', {
      result: '*',
      updatedAt: new Date('2026-05-01T10:00:00Z'),
    });
    // Nakamura белыми — та же пара, обратный порядок
    const g2 = makeGame('g2', 'Nakamura', 'Carlsen', {
      result: '1/2-1/2',
      fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2',
      updatedAt: new Date('2026-05-01T14:00:00Z'),
    });
    const out = deduplicateGamesByPair([g1, g2]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('g2');
  });

  it('игра без имён игроков проходит без дедупликации', () => {
    const anon1 = makeGame('a1', null, null);
    const anon2 = makeGame('a2', null, null);
    const out = deduplicateGamesByPair([anon1, anon2]);
    expect(out).toHaveLength(2);
  });

  it('Sigeman-like: 4 пары × 2 записи → 4 результата (реальные)', () => {
    const d = (iso: string) => new Date(iso);
    const games = [
      // Placeholder-ы (вчера)
      makeGame('ph1', 'Grandelius', 'Carlsen', { updatedAt: d('2026-05-01T00:00:00Z') }),
      makeGame('ph2', 'Erdogmus', 'Erigaisi', { updatedAt: d('2026-05-01T00:00:00Z') }),
      makeGame('ph3', 'Van Foreest', 'Zhu', { updatedAt: d('2026-05-01T00:00:00Z') }),
      makeGame('ph4', 'Abdusattorov', 'Woodward', { updatedAt: d('2026-05-01T00:00:00Z') }),
      // Реальные (сегодня)
      makeGame('r1', 'Grandelius', 'Carlsen', {
        result: '0-1',
        fen: 'some-fen',
        updatedAt: d('2026-05-02T10:00:00Z'),
      }),
      makeGame('r2', 'Erdogmus', 'Erigaisi', {
        result: '0-1',
        fen: 'some-fen',
        updatedAt: d('2026-05-02T10:00:00Z'),
      }),
      makeGame('r3', 'Van Foreest', 'Zhu', {
        result: '1/2-1/2',
        fen: 'some-fen',
        updatedAt: d('2026-05-02T10:00:00Z'),
      }),
      makeGame('r4', 'Abdusattorov', 'Woodward', {
        result: '1-0',
        fen: 'some-fen',
        updatedAt: d('2026-05-02T10:00:00Z'),
      }),
    ];
    const out = deduplicateGamesByPair(games);
    expect(out).toHaveLength(4);
    const ids = out.map((g) => g.id).sort();
    expect(ids).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});

// KS-2450 — top-3 фавориты по рейтингу.
describe('buildTopPlayers (KS-2450)', () => {
  it('пустой вход → []', () => {
    expect(buildTopPlayers([])).toEqual([]);
  });

  it('сортировка elo DESC, top-3', () => {
    const out = buildTopPlayers([
      { name: 'Carlsen', elo: 2830 },
      { name: 'Nakamura', elo: 2810 },
      { name: 'Caruana', elo: 2820 },
      { name: 'Ding', elo: 2780 },
      { name: 'Nepo', elo: 2790 },
    ]);
    expect(out).toEqual([
      { name: 'Carlsen', elo: 2830 },
      { name: 'Caruana', elo: 2820 },
      { name: 'Nakamura', elo: 2810 },
    ]);
  });

  it('дедуп по name — берём максимальный elo', () => {
    const out = buildTopPlayers([
      { name: 'Carlsen', elo: 2820 },
      { name: 'Carlsen', elo: 2830 },
      { name: 'Carlsen', elo: 2810 },
    ]);
    expect(out).toEqual([{ name: 'Carlsen', elo: 2830 }]);
  });

  it('tie-break по name ASC при равном elo', () => {
    const out = buildTopPlayers([
      { name: 'Carlsen', elo: 2800 },
      { name: 'Anand', elo: 2800 },
      { name: 'Bareev', elo: 2800 },
      { name: 'Topalov', elo: 2800 },
    ]);
    expect(out).toEqual([
      { name: 'Anand', elo: 2800 },
      { name: 'Bareev', elo: 2800 },
      { name: 'Carlsen', elo: 2800 },
    ]);
  });

  it('игнорирует пустые имена и невалидное elo', () => {
    const out = buildTopPlayers([
      { name: 'Valid', elo: 2700 },
      { name: '', elo: 2800 },
      { name: null, elo: 2900 },
      { name: 'NoElo', elo: null },
      { name: 'ZeroElo', elo: 0 },
      { name: 'NegElo', elo: -100 },
      { name: '   ', elo: 2700 },
    ]);
    expect(out).toEqual([{ name: 'Valid', elo: 2700 }]);
  });

  it('меньше limit игроков → возвращает все', () => {
    const out = buildTopPlayers([
      { name: 'A', elo: 2700 },
      { name: 'B', elo: 2600 },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('avgEloOfTopN (KS-4395)', () => {
  it('пустой массив → null', () => {
    expect(avgEloOfTopN([])).toBeNull();
  });

  it('меньше 10 игроков → среднее по всем', () => {
    expect(avgEloOfTopN([2700, 2600, 2500])).toBeCloseTo(2600, 5);
  });

  it('ровно 10 игроков → среднее по всем', () => {
    const elos = [2700, 2600, 2500, 2400, 2300, 2200, 2100, 2000, 1900, 1800];
    expect(avgEloOfTopN(elos)).toBeCloseTo(2250, 5);
  });

  it('больше 10 игроков → среднее по топ-10, низы игнорируются (опен-эффект)', () => {
    const top10 = [2750, 2700, 2700, 2650, 2650, 2600, 2600, 2550, 2550, 2500];
    const longTail = Array.from({ length: 90 }, () => 1800);
    const all = [...top10, ...longTail];
    // По всем 100: (top10sum + 90*1800)/100 ≈ 1857. По топ-10: 2625.
    const expectedTop10 = top10.reduce((a, b) => a + b, 0) / top10.length;
    expect(avgEloOfTopN(all)).toBeCloseTo(expectedTop10, 5);
  });

  it('порядок входа не влияет (берём топ-N независимо)', () => {
    const sorted = [2800, 2700, 2600, 2500, 2400];
    const shuffled = [2400, 2800, 2500, 2700, 2600];
    expect(avgEloOfTopN(sorted)).toBeCloseTo(avgEloOfTopN(shuffled)!, 5);
  });

  it('n=1 → максимум', () => {
    expect(avgEloOfTopN([2400, 2800, 2600], 1)).toBe(2800);
  });

  it('n=0 защита: всё равно берём как минимум одного игрока', () => {
    expect(avgEloOfTopN([2700, 2600], 0)).toBe(2700);
  });
});

describe('isPinnedTitleExcluded (KS-4401)', () => {
  // Импорт делаем здесь, чтобы не плодить блок import выше; на запуске
  // тестов модуль уже подтянулся.
  const { isPinnedTitleExcluded } = jest.requireActual(
    './broadcast.controller',
  );

  it('null / undefined / пустая строка → false', () => {
    expect(isPinnedTitleExcluded(null)).toBe(false);
    expect(isPinnedTitleExcluded(undefined)).toBe(false);
    expect(isPinnedTitleExcluded('')).toBe(false);
  });

  it('точное "TCEC" → true', () => {
    expect(isPinnedTitleExcluded('TCEC')).toBe(true);
  });

  it('lowercase tcec → true', () => {
    expect(isPinnedTitleExcluded('tcec')).toBe(true);
  });

  it('смешанный регистр TcEc → true', () => {
    expect(isPinnedTitleExcluded('TcEc')).toBe(true);
  });

  it('"TCEC Season 27" → true', () => {
    expect(isPinnedTitleExcluded('TCEC Season 27')).toBe(true);
  });

  it('подстрока в середине → true', () => {
    expect(isPinnedTitleExcluded('Top Chess Engine TCEC Cup')).toBe(true);
  });

  it('"not-tcec" → true (содержит подстроку)', () => {
    // Намеренная семантика: ищем любое вхождение `tcec`. Если в проде
    // появится «not-tcec» как реальное название — расширим до regex
    // с границами слова.
    expect(isPinnedTitleExcluded('not-tcec')).toBe(true);
  });

  it('человеческий турнир без tcec → false', () => {
    expect(isPinnedTitleExcluded('Norway Chess 2026')).toBe(false);
    expect(isPinnedTitleExcluded('Tata Steel Chess')).toBe(false);
    expect(isPinnedTitleExcluded('Candidates')).toBe(false);
  });
});
