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
            has_live: false,
            has_upcoming: false,
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

      // 5. КЛЮЧЕВОЕ — `where: { isActive: true }` НЕ передан в findMany.
      const findManyCall = findManyMock.mock.calls[0][0];
      expect(findManyCall.where).toBeUndefined();
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
