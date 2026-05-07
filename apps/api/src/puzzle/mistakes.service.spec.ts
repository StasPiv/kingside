import { MistakesService } from './mistakes.service';

describe('MistakesService (L-31, KS-1802)', () => {
  let service: MistakesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      puzzle: {
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      userMistake: {
        findFirst: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      $queryRawUnsafe: jest.fn(),
    };
    service = new MistakesService(prisma);
  });

  // ─── recordPuzzleMistake ──────────────────────────────────────────

  describe('recordPuzzleMistake', () => {
    it('создаёт запись с темами из Puzzle.themes, когда ошибки ещё не было', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({ themes: 'fork pin hangingPiece' });
      prisma.userMistake.findFirst.mockResolvedValue(null);

      await service.recordPuzzleMistake('u1', 'p1');

      expect(prisma.userMistake.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          source: 'puzzle',
          puzzleId: 'p1',
          themes: ['fork', 'pin', 'hangingPiece'],
        },
      });
      expect(prisma.userMistake.update).not.toHaveBeenCalled();
    });

    it('идемпотентность: при повторной ошибке по той же задаче только обновляет occurredAt, не создаёт дубликат', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({ themes: 'fork' });
      prisma.userMistake.findFirst.mockResolvedValue({ id: 'm1' });

      await service.recordPuzzleMistake('u1', 'p1');

      expect(prisma.userMistake.create).not.toHaveBeenCalled();
      expect(prisma.userMistake.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({ themes: ['fork'] }),
      });
      const updateArg = prisma.userMistake.update.mock.calls[0][0];
      expect(updateArg.data.occurredAt).toBeInstanceOf(Date);
    });

    it('не падает, если puzzle не найден (просто логирует и возвращает undefined)', async () => {
      prisma.puzzle.findUnique.mockResolvedValue(null);

      await expect(service.recordPuzzleMistake('u1', 'missing')).resolves.toBeUndefined();
      expect(prisma.userMistake.create).not.toHaveBeenCalled();
      expect(prisma.userMistake.update).not.toHaveBeenCalled();
    });

    it('молча игнорирует гонку (P2002 на partial-unique индексе)', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({ themes: 'fork' });
      prisma.userMistake.findFirst.mockResolvedValue(null);
      const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      prisma.userMistake.create.mockRejectedValue(err);

      await expect(service.recordPuzzleMistake('u1', 'p1')).resolves.toBeUndefined();
    });

    it('прокидывает не-P2002 ошибки', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({ themes: 'fork' });
      prisma.userMistake.findFirst.mockResolvedValue(null);
      const err = Object.assign(new Error('db dead'), { code: 'P1001' });
      prisma.userMistake.create.mockRejectedValue(err);

      await expect(service.recordPuzzleMistake('u1', 'p1')).rejects.toBe(err);
    });

    // ── KS-2491 / ADR-046 §5.1. MODE_TAG_BLACKLIST ──────────────────

    it('KS-2491: фильтрует playVsEngine при наличии тематик (mate playVsEngine)', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        themes: 'mate playVsEngine',
      });
      prisma.userMistake.findFirst.mockResolvedValue(null);

      await service.recordPuzzleMistake('u1', 'p1');

      expect(prisma.userMistake.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          source: 'puzzle',
          puzzleId: 'p1',
          themes: ['mate'],
        },
      });
    });

    it('KS-2491: themes=playVsEngine (только маркер) → пустой массив', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({ themes: 'playVsEngine' });
      prisma.userMistake.findFirst.mockResolvedValue(null);

      await service.recordPuzzleMistake('u1', 'p1');

      expect(prisma.userMistake.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          source: 'puzzle',
          puzzleId: 'p1',
          themes: [],
        },
      });
    });

    it('KS-2491: тематики без mode-маркера остаются без изменений', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({ themes: 'mate fork' });
      prisma.userMistake.findFirst.mockResolvedValue(null);

      await service.recordPuzzleMistake('u1', 'p1');

      expect(prisma.userMistake.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          source: 'puzzle',
          puzzleId: 'p1',
          themes: ['mate', 'fork'],
        },
      });
    });

    it('KS-2491: фильтр работает и на update-пути (existing mistake)', async () => {
      prisma.puzzle.findUnique.mockResolvedValue({
        themes: 'crushing playVsEngine knightMove',
      });
      prisma.userMistake.findFirst.mockResolvedValue({ id: 'm-existing' });

      await service.recordPuzzleMistake('u1', 'p1');

      expect(prisma.userMistake.update).toHaveBeenCalledWith({
        where: { id: 'm-existing' },
        data: expect.objectContaining({
          themes: ['crushing', 'knightMove'],
        }),
      });
    });
  });

  // ─── recordGameMistake ────────────────────────────────────────────

  describe('recordGameMistake', () => {
    it('создаёт запись с themes, переданными аргументом', async () => {
      prisma.userMistake.findFirst.mockResolvedValue(null);

      await service.recordGameMistake('u1', 'g1', 42, ['kingsideAttack']);

      expect(prisma.userMistake.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          source: 'game_review',
          gameId: 'g1',
          ply: 42,
          themes: ['kingsideAttack'],
        },
      });
    });

    it('идемпотентность: по той же тройке (userId, gameId, ply) — update, не create', async () => {
      prisma.userMistake.findFirst.mockResolvedValue({ id: 'm2' });

      await service.recordGameMistake('u1', 'g1', 42, []);

      expect(prisma.userMistake.create).not.toHaveBeenCalled();
      expect(prisma.userMistake.update).toHaveBeenCalledWith({
        where: { id: 'm2' },
        data: expect.objectContaining({ themes: [] }),
      });
    });
  });

  // ─── getAggregates ────────────────────────────────────────────────

  describe('getAggregates', () => {
    it('группирует по темам через UNNEST, сортирует по count DESC, применяет default limit', async () => {
      const rows = [
        { theme: 'fork', count: 7n, last_occurred_at: new Date('2026-04-20T10:00:00Z') },
        { theme: 'pin', count: 3n, last_occurred_at: new Date('2026-04-21T10:00:00Z') },
      ];
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce(rows) // aggregates
        .mockResolvedValueOnce([{ total: 2n }]); // totalThemes

      const r = await service.getAggregates('u1');

      expect(r.aggregates).toEqual([
        { theme: 'fork', count: 7, lastOccurredAt: '2026-04-20T10:00:00.000Z' },
        { theme: 'pin', count: 3, lastOccurredAt: '2026-04-21T10:00:00.000Z' },
      ]);
      expect(r.totalThemes).toBe(2);
      expect(r.since).toBeNull();
      expect(r.limit).toBe(MistakesService.AGGREGATE_DEFAULT_LIMIT);

      // Проверяем параметры SQL: без since — один параметр, userId.
      const firstCall = prisma.$queryRawUnsafe.mock.calls[0];
      expect(firstCall.slice(1)).toEqual(['u1']);
      expect(firstCall[0]).toContain('UNNEST(themes)');
      expect(firstCall[0]).toContain('ORDER BY count DESC');
      expect(firstCall[0]).not.toContain('occurred_at >=');
    });

    it('фильтр since добавляет $2 и строку "AND occurred_at >= $2"', async () => {
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);

      const since = new Date('2026-03-23T00:00:00Z');
      await service.getAggregates('u1', { since, limit: 5 });

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('occurred_at >= $2');
      expect(params).toEqual(['u1', since.toISOString()]);
    });

    it('обрезает до limit и кламит его в [1 .. MAX]', async () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        theme: `t${i}`,
        count: BigInt(100 - i),
        last_occurred_at: new Date(),
      }));
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ total: 60n }]);

      // limit=999 должен быть зажат до AGGREGATE_MAX_LIMIT
      const r = await service.getAggregates('u1', { limit: 999 });
      expect(r.aggregates.length).toBe(MistakesService.AGGREGATE_MAX_LIMIT);
      expect(r.limit).toBe(MistakesService.AGGREGATE_MAX_LIMIT);
      // totalThemes отражает все уникальные темы, а не обрезанный список
      expect(r.totalThemes).toBe(60);
    });
  });

  // ─── getRecommendations ───────────────────────────────────────────

  describe('getRecommendations', () => {
    it('возвращает топ-N тем за окно windowDays, с PuzzleStep-payload вокруг ratingPuzzle', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1400 });
      const rows = [
        { theme: 'fork', count: 10n, last_occurred_at: new Date('2026-04-22T10:00:00Z') },
        { theme: 'pin', count: 6n, last_occurred_at: new Date('2026-04-21T10:00:00Z') },
        { theme: 'hangingPiece', count: 4n, last_occurred_at: new Date('2026-04-20T10:00:00Z') },
        { theme: 'skewer', count: 2n, last_occurred_at: new Date('2026-04-19T10:00:00Z') },
      ];
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce(rows) // aggregates → slice(0, TOP_N)
        .mockResolvedValueOnce([{ total: rows.length }]); // totalThemes

      const r = await service.getRecommendations('u1');

      expect(r.ratingPuzzle).toBe(1400);
      expect(r.windowDays).toBe(MistakesService.RECOMMENDATION_WINDOW_DAYS);
      expect(r.ratingRange).toBe(MistakesService.RECOMMENDATION_RATING_RANGE);
      expect(r.recommendations).toHaveLength(MistakesService.RECOMMENDATION_TOP_N);

      const expectedMin = 1400 - MistakesService.RECOMMENDATION_RATING_RANGE;
      const expectedMax = 1400 + MistakesService.RECOMMENDATION_RATING_RANGE;

      expect(r.recommendations[0]).toEqual({
        theme: 'fork',
        mistakeCount: 10,
        lastOccurredAt: '2026-04-22T10:00:00.000Z',
        puzzleStep: {
          type: 'puzzle',
          selection: {
            mode: 'filter',
            themes: ['fork'],
            ratingMin: expectedMin,
            ratingMax: expectedMax,
            limit: 10,
          },
          minSolved: 5,
        },
      });
      expect(r.recommendations.map((x) => x.theme)).toEqual(['fork', 'pin', 'hangingPiece']);
    });

    it('fallback на ratingPuzzle=1500, если user не найден; ratingMin не уходит в минус', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([
          { theme: 'fork', count: 1n, last_occurred_at: new Date() },
        ])
        .mockResolvedValueOnce([{ total: 1n }]);

      const r = await service.getRecommendations('u1');
      expect(r.ratingPuzzle).toBe(1500);
      expect(r.recommendations[0].puzzleStep.selection).toMatchObject({
        mode: 'filter',
        ratingMin: 1500 - MistakesService.RECOMMENDATION_RATING_RANGE,
        ratingMax: 1500 + MistakesService.RECOMMENDATION_RATING_RANGE,
      });
    });

    it('передаёт в getAggregates since = now - windowDays', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);

      const before = Date.now();
      await service.getRecommendations('u1');
      const after = Date.now();

      const sqlCall = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sqlCall[0]).toContain('occurred_at >= $2');
      const sinceIso = sqlCall[2] as string;
      const sinceMs = new Date(sinceIso).getTime();
      const windowMs = MistakesService.RECOMMENDATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      // Допуск ±2 секунды на выполнение.
      expect(sinceMs).toBeGreaterThanOrEqual(before - windowMs - 2000);
      expect(sinceMs).toBeLessThanOrEqual(after - windowMs + 2000);
    });

    it('пустой список рекомендаций, если агрегатов нет', async () => {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
      prisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);

      const r = await service.getRecommendations('u1');
      expect(r.recommendations).toEqual([]);
    });
  });
});
