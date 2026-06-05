import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AnalysisService } from './analysis.service';

describe('AnalysisService', () => {
  let service: AnalysisService;
  let prisma: {
    analysis: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      // KS-3261: findFirst используется в dedup-lookup (опц. — добавляется
      // динамически в тестах, поэтому Mock | undefined).
      findFirst?: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  const userId = 'user-1';
  const otherId = 'user-2';
  const mockAnalysis = {
    id: 'analysis-1',
    userId,
    title: 'Test analysis',
    pgn: null,
    fen: null,
    opening: null,
    category: 'analysis',
    tags: '',
    currentPosition: null,
    boardOrientation: null as 'white' | 'black' | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    prisma = {
      analysis: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        // KS-3261: default update mock — findOne делает async LRU bump
        // через update(); если mock не возвращает promise, .catch() в
        // service'е валится с "Cannot read properties of undefined".
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn(),
      },
    };
    service = new AnalysisService(prisma as any);
  });

  describe('create', () => {
    it('should create analysis with default title', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);

      await service.create(userId, {});

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId,
          title: expect.stringContaining('New analysis'),
        }),
      });
    });

    it('should create analysis with custom title', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);

      await service.create(userId, { title: 'My Game' });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ title: 'My Game' }),
      });
    });

    it('should extract opening from PGN', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const pgn = '[Opening "Sicilian Defense"]\n1. e4 c5';

      await service.create(userId, { pgn });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ opening: 'Sicilian Defense' }),
      });
    });

    // ── KS-2280 (ADR-037 §6.5): PGN с NAG-аннотациями/комментариями
    // сохраняется в БД дословно — никакая нормализация body/strip
    // токенов в analysis.service не делается. PgnSerializer на фронте
    // отвечает за корректный формат.

    it('KS-2280: forward-order `$N {comment}` сохраняется как есть', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const pgn = '1. e4 $1 {good!} e5 *';

      await service.create(userId, { pgn });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ pgn }),
      });
    });

    it('KS-2280: reverse-order `{comment} $N` сохраняется как есть', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const pgn = '1. e4 {good!} $1 e5 *';

      await service.create(userId, { pgn });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ pgn }),
      });
    });

    it('KS-2280: PGN с несколькими NAG-токенами — body не теряется', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const pgn = '1. e4 $1 $14 {white slightly better} e5 *';

      await service.create(userId, { pgn });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ pgn }),
      });
    });

    // ── KS-2598 (ADR-051 §4 этап A1): POST /analyses с пустым pgn=''
    // должен создавать запись и сохранять PGN как пустую строку (а не
    // null и не подставлять DEFAULT_FEN). Точки входа «+Новый анализ»,
    // «Анализ из пазла», «Свободная партия» дёргают единый helper
    // openAnalysisFromPgn — backend обязан принять пустой PGN без
    // ошибок валидации.

    it('KS-2598: POST с pgn="" сохраняет запись с пустой строкой', async () => {
      prisma.analysis.create.mockResolvedValue({ ...mockAnalysis, pgn: '' });

      await service.create(userId, { pgn: '' });

      const data = prisma.analysis.create.mock.calls[0][0].data;
      expect(data.pgn).toBe('');
      // никаких автоматических подстановок DEFAULT_FEN в тело
      expect(data.fen).toBeNull();
      expect(data.userId).toBe(userId);
      expect(data.title).toEqual(expect.stringContaining('New analysis'));
    });

    it('KS-2598: POST без pgn (undefined) сохраняет запись с null', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);

      await service.create(userId, {});

      const data = prisma.analysis.create.mock.calls[0][0].data;
      expect(data.pgn).toBeNull();
    });

    // ── KS-3724: подтверждение контракта. POST с произвольным FEN
    // сохраняет переданное значение в data.fen, а не null/дефолт.
    // Если этот тест падает — корень бага «не сохраняется стартовая
    // позиция» на бэке; если зелёный — корень на клиенте (фронт не
    // шлёт поле `fen`, или шлёт под другим именем, и ValidationPipe
    // whitelist=true в `main.ts` молча отбрасывает).
    it('KS-3724: POST с произвольным fen сохраняет его в data.fen', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';

      await service.create(userId, { fen });

      const data = prisma.analysis.create.mock.calls[0][0].data;
      expect(data.fen).toBe(fen);
    });

    it('KS-2598 регрессия: непустой PGN сохраняется без изменений', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const pgn = '[White "Carlsen"]\n[Black "Nepo"]\n\n1. e4 c5 *';

      await service.create(userId, { pgn });

      const data = prisma.analysis.create.mock.calls[0][0].data;
      expect(data.pgn).toBe(pgn);
      expect(data.white).toBe('Carlsen');
      expect(data.black).toBe('Nepo');
    });

    // ── KS-3261: дедуп по source_hash при повторном открытии партии ──

    describe('KS-3261 dedup', () => {
      it('lichessGameId — source_hash="lichess:<id>"', () => {
        const h = AnalysisService.computeSourceHash({
          lichessGameId: 'abc12345',
        });
        expect(h).toBe('lichess:abc12345');
      });

      it('archiveGameId — source_hash="archive:<uuid>"', () => {
        const h = AnalysisService.computeSourceHash({
          archiveGameId: 'e1b8aaa0-1111-4444-8888-cccccccccccc',
        });
        expect(h).toBe('archive:e1b8aaa0-1111-4444-8888-cccccccccccc');
      });

      it('PGN-headers — детерминированный sha256 (одинаковые headers → один hash)', () => {
        const pgn1 = '[White "Lu Shanglei"]\n[Black "Bortnyk, Olexandr"]\n[Date "2026.05.22"]\n[Event "Test"]\n[Round "1"]';
        const pgn2 = '[White "  LU SHANGLEI  "]\n[Black "BORTNYK, OLEXANDR"]\n[Date "2026.05.22"]\n[Event "test"]\n[Round "1"]\n\n1. e4 c5'; // normalize trim+lower; movetext игнорируется
        const h1 = AnalysisService.computeSourceHash({ pgn: pgn1 });
        const h2 = AnalysisService.computeSourceHash({ pgn: pgn2 });
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^pgn:[0-9a-f]{64}$/);
      });

      it('PGN без White → null (не дедупим, headers неполные)', () => {
        const pgn = '[Black "X"]\n[Date "2026.01.01"]';
        expect(AnalysisService.computeSourceHash({ pgn })).toBeNull();
      });

      it('PGN без Black → null', () => {
        const pgn = '[White "X"]\n[Date "2026.01.01"]';
        expect(AnalysisService.computeSourceHash({ pgn })).toBeNull();
      });

      it('PGN без Date → null', () => {
        const pgn = '[White "X"]\n[Black "Y"]';
        expect(AnalysisService.computeSourceHash({ pgn })).toBeNull();
      });

      it('пустой input → null', () => {
        expect(AnalysisService.computeSourceHash({})).toBeNull();
      });

      it('приоритет: lichessGameId > archiveGameId > PGN', () => {
        const all = AnalysisService.computeSourceHash({
          lichessGameId: 'LCH',
          archiveGameId: 'arch-uuid',
          pgn: '[White "A"]\n[Black "B"]\n[Date "2026.01.01"]',
        });
        expect(all).toBe('lichess:LCH');
        const noLichess = AnalysisService.computeSourceHash({
          archiveGameId: 'arch-uuid',
          pgn: '[White "A"]\n[Black "B"]\n[Date "2026.01.01"]',
        });
        expect(noLichess).toBe('archive:arch-uuid');
      });

      it('create с lichessGameId + найден существующий → возвращает existing, не создаёт новый', async () => {
        const existing = {
          ...mockAnalysis,
          id: 'a-existing',
          lichessGameId: 'LhpNkgC9',
          sourceHash: 'lichess:LhpNkgC9',
        };
        prisma.analysis.findFirst = jest.fn().mockResolvedValue(existing);
        // KS-3262: create возвращает то, что вернул update — мокаем явно.
        prisma.analysis.update.mockResolvedValue(existing);

        const result = await service.create(userId, {
          pgn: '1. e4',
          lichessGameId: 'LhpNkgC9',
        });

        expect(prisma.analysis.findFirst).toHaveBeenCalledWith({
          where: { userId, sourceHash: { in: ['lichess:LhpNkgC9'] } },
        });
        expect(prisma.analysis.create).not.toHaveBeenCalled();
        expect(prisma.analysis.update).toHaveBeenCalledWith({
          where: { id: 'a-existing' },
          data: expect.objectContaining({
            lastOpenedAt: expect.any(Date),
          }),
        });
        expect(result).toMatchObject({ id: 'a-existing', existing: true });
      });

      it('KS-3262: dedup находит legacy-запись с pgn-hash, когда пришёл lichessGameId, и апгрейдит её', async () => {
        // Legacy: запись создана ДО KS-3261 deploy без lichessGameId,
        // имеет source_hash='pgn:<headers-hash>' и lichess_game_id=NULL.
        const legacyRecord = {
          ...mockAnalysis,
          id: 'a-legacy',
          sourceHash: 'pgn:dc72a7cc467f212a95fe88964b3c4e09f528f39bce5f2c244448e80a3d9e9570',
          lichessGameId: null as string | null,
          archiveGameId: null as string | null,
        };
        prisma.analysis.findFirst = jest.fn().mockResolvedValue(legacyRecord);
        prisma.analysis.update.mockResolvedValue({
          ...legacyRecord,
          sourceHash: 'lichess:7qKxg3w1',
          lichessGameId: '7qKxg3w1',
        });

        const pgnWithHeaders =
          '[White "Deac, Bogdan-Daniel"]\n[Black "Caruana, F"]\n[Date "2026.05.18"]\n[Event "GCT"]\n[Round "5.2"]\n\n1. d4 *';

        const result = await service.create(userId, {
          pgn: pgnWithHeaders,
          lichessGameId: '7qKxg3w1',
        });

        // Lookup делается по IN [lichess:7qKxg3w1, pgn:<sha>] — оба
        // applicable хеша, поэтому legacy с pgn-hash находится.
        expect(prisma.analysis.findFirst).toHaveBeenCalledWith({
          where: {
            userId,
            sourceHash: { in: expect.arrayContaining([
              'lichess:7qKxg3w1',
              expect.stringMatching(/^pgn:[0-9a-f]{64}$/),
            ]) },
          },
        });
        // Upgrade: sourceHash + lichessGameId перезаписываются на preferred.
        expect(prisma.analysis.update).toHaveBeenCalledWith({
          where: { id: 'a-legacy' },
          data: expect.objectContaining({
            sourceHash: 'lichess:7qKxg3w1',
            lichessGameId: '7qKxg3w1',
            lastOpenedAt: expect.any(Date),
          }),
        });
        expect(prisma.analysis.create).not.toHaveBeenCalled();
        expect(result).toMatchObject({ id: 'a-legacy', existing: true });
      });

      it('KS-3263: source-id без pgn + удачный FDW-резолв из archive_games_remote → анализ с резолвленным pgn', async () => {
        // Резолвер делает SELECT из foreign table archive_games_remote
        // (postgres_fdw, KS-2760). Мокаем $queryRawUnsafe.
        const archiveGameUuid = 'f18fbe5a-6e97-455b-a3a4-37cd13c60e6a';
        prisma.analysis.findFirst = jest.fn().mockResolvedValue(null);
        (prisma as unknown as { $queryRawUnsafe: jest.Mock }).$queryRawUnsafe = jest
          .fn()
          .mockResolvedValue([
            {
              pgn: '[White "A"]\n[Black "B"]\n[Date "2026.05.18"]\n\n1. e4 *',
              white_name: 'A',
              black_name: 'B',
              white_elo: 2700,
              black_elo: 2700,
              result: '1-0',
            },
          ]);
        prisma.analysis.create.mockResolvedValue({
          ...mockAnalysis,
          id: 'a-resolved',
          pgn: '[White "A"]...',
        });

        const result = await service.create(userId, {
          archiveGameId: archiveGameUuid,
        });

        // FDW-резолвер был вызван.
        expect(
          (prisma as unknown as { $queryRawUnsafe: jest.Mock }).$queryRawUnsafe,
        ).toHaveBeenCalledWith(
          expect.stringContaining('archive_games_remote'),
          archiveGameUuid,
        );
        expect(prisma.analysis.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            archiveGameId: archiveGameUuid,
            sourceHash: `archive:${archiveGameUuid}`,
            pgn: expect.stringContaining('1. e4'),
          }),
        });
        expect(result).toMatchObject({ id: 'a-resolved', existing: false });
      });

      it('KS-3263: source-id без pgn + FDW вернул пустой результат → анализ с pgn=null', async () => {
        prisma.analysis.findFirst = jest.fn().mockResolvedValue(null);
        (prisma as unknown as { $queryRawUnsafe: jest.Mock }).$queryRawUnsafe = jest
          .fn()
          .mockResolvedValue([]);
        prisma.analysis.create.mockResolvedValue({
          ...mockAnalysis,
          id: 'a-stub',
        });

        await service.create(userId, {
          archiveGameId: 'f18fbe5a-6e97-455b-a3a4-37cd13c60e6a',
        });

        expect(prisma.analysis.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            pgn: null,
            archiveGameId: 'f18fbe5a-6e97-455b-a3a4-37cd13c60e6a',
            sourceHash: 'archive:f18fbe5a-6e97-455b-a3a4-37cd13c60e6a',
          }),
        });
      });

      it('KS-3262: если existing уже с lichess-hash и lichessGameId — upgrade не делается (только lastOpenedAt)', async () => {
        const alreadyUpgraded = {
          ...mockAnalysis,
          id: 'a-upgraded',
          sourceHash: 'lichess:7qKxg3w1',
          lichessGameId: '7qKxg3w1',
        };
        prisma.analysis.findFirst = jest.fn().mockResolvedValue(alreadyUpgraded);
        prisma.analysis.update.mockResolvedValue(alreadyUpgraded);

        await service.create(userId, {
          lichessGameId: '7qKxg3w1',
        });

        // Update data содержит ТОЛЬКО lastOpenedAt — sourceHash/lichessGameId
        // не перезаписываются если уже совпадают.
        const updateCall = prisma.analysis.update.mock.calls[0][0];
        expect(Object.keys(updateCall.data)).toEqual(['lastOpenedAt']);
      });

      it('create с lichessGameId + НЕ найден → создаёт нового с sourceHash и lichessGameId', async () => {
        prisma.analysis.findFirst = jest.fn().mockResolvedValue(null);
        prisma.analysis.create.mockResolvedValue({
          ...mockAnalysis,
          id: 'a-new',
          sourceHash: 'lichess:NEW123',
          lichessGameId: 'NEW123',
        });

        const result = await service.create(userId, {
          lichessGameId: 'NEW123',
        });

        expect(prisma.analysis.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            sourceHash: 'lichess:NEW123',
            lichessGameId: 'NEW123',
            lastOpenedAt: expect.any(Date),
          }),
        });
        expect(result).toMatchObject({ id: 'a-new', existing: false });
      });

      it('create без source-данных и неполных headers → создаёт нового с sourceHash=null', async () => {
        prisma.analysis.create.mockResolvedValue({ ...mockAnalysis, sourceHash: null });

        await service.create(userId, { pgn: '1. e4' });

        // findFirst НЕ вызван (нечего искать)
        expect(prisma.analysis.findFirst).toBeUndefined();
        expect(prisma.analysis.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ sourceHash: null }),
        });
      });
    });

    describe('KS-3261 checkExistingBySource (bulk-check)', () => {
      it('возвращает map lichessId→analysisId для найденных и null для не найденных', async () => {
        prisma.analysis.findMany.mockResolvedValue([
          { id: 'a1', lichessGameId: 'X1' },
          { id: 'a2', lichessGameId: 'X3' },
        ]);

        const result = await service.checkExistingBySource(userId, {
          lichessGameIds: ['X1', 'X2', 'X3'],
        });

        expect(result.lichess).toEqual({ X1: 'a1', X2: null, X3: 'a2' });
        expect(result.archive).toEqual({});
        expect(prisma.analysis.findMany).toHaveBeenCalledWith({
          where: { userId, lichessGameId: { in: ['X1', 'X2', 'X3'] } },
          select: { id: true, lichessGameId: true },
        });
      });

      it('пустые массивы → пустые map (без запросов в БД)', async () => {
        const result = await service.checkExistingBySource(userId, {});
        expect(result).toEqual({ lichess: {}, archive: {} });
        expect(prisma.analysis.findMany).not.toHaveBeenCalled();
      });
    });

    // ── KS-2600 (ADR-051 §3 share-1): новая запись по умолчанию
    // приватная (`isPublic=false`). Контракт: backend не передаёт
    // явное значение в Prisma при create — поле получает `false` из
    // schema.prisma `@default(false)`. Тест фиксирует, что сервис не
    // включает `isPublic` в payload (Prisma подставит default сама).
    it('KS-2600: create НЕ передаёт isPublic — Prisma подставит default=false', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);

      await service.create(userId, { pgn: '' });

      const data = prisma.analysis.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('isPublic');
    });
  });

  describe('findAll', () => {
    it('KS-3261: should return analyses for user ordered by lastOpenedAt DESC', async () => {
      // KS-3261: orderBy переехал с createdAt на lastOpenedAt (LRU).
      // Для legacy-записей миграция выставила lastOpenedAt = createdAt,
      // так что порядок старого хвоста сохраняется.
      prisma.analysis.findMany.mockResolvedValue([mockAnalysis]);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      expect(prisma.analysis.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          orderBy: { lastOpenedAt: 'desc' },
        }),
      );
    });

    // ── KS-2948: дефолтный limit=20, max=100, offset=0;
    // в select по умолчанию НЕТ `pgn` / `fen` / `currentPosition`
    // (защита от 200КБ tool_result в MCP getUserAnalyses).
    describe('KS-2948 pagination & PGN exclusion', () => {
      it('применяет дефолтный limit=20 и skip=0 без options', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId);

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.take).toBe(20);
        expect(call.skip).toBe(0);
      });

      it('select по умолчанию НЕ содержит pgn/fen/currentPosition', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId);

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.select.pgn).toBeUndefined();
        expect(call.select.fen).toBeUndefined();
        expect(call.select.currentPosition).toBeUndefined();
        // метаданные должны быть в select
        expect(call.select.id).toBe(true);
        expect(call.select.title).toBe(true);
        expect(call.select.headline).toBe(true);
      });

      it('withPgn=true добавляет pgn/fen/currentPosition в select', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { withPgn: true });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.select.pgn).toBe(true);
        expect(call.select.fen).toBe(true);
        expect(call.select.currentPosition).toBe(true);
      });

      it('limit клампится сверху до 100', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { limit: 5000 });

        expect(prisma.analysis.findMany.mock.calls[0][0].take).toBe(100);
      });

      it('limit клампится снизу до 1', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { limit: 0 });

        expect(prisma.analysis.findMany.mock.calls[0][0].take).toBe(1);
      });

      it('limit с NaN → дефолт 20', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { limit: Number.NaN });

        expect(prisma.analysis.findMany.mock.calls[0][0].take).toBe(20);
      });

      it('offset передаётся как skip и клампится снизу до 0', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { offset: -5 });

        expect(prisma.analysis.findMany.mock.calls[0][0].skip).toBe(0);
      });

      it('offset=40, limit=10 → take=10, skip=40', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { limit: 10, offset: 40 });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.take).toBe(10);
        expect(call.skip).toBe(40);
      });

      it('дробный limit → Math.floor', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { limit: 12.7 });

        expect(prisma.analysis.findMany.mock.calls[0][0].take).toBe(12);
      });
    });

    // KS-3203: server-side ILIKE-поиск как drop-in для frontend-loop'а.
    describe('KS-3203 ?search=', () => {
      it('search undefined → where только { userId }, без AND', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, {});

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.where).toEqual({ userId });
        expect(call.where.AND).toBeUndefined();
      });

      it('search="" → старое поведение (без AND)', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { search: '' });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.where).toEqual({ userId });
      });

      it('search="   " (whitespace) → без AND', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { search: '   ' });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.where).toEqual({ userId });
      });

      it('одно слово → AND с одним фильтром, OR по 8 полям с mode=insensitive', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { search: 'Pivovartsev' });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.where.userId).toBe(userId);
        expect(call.where.AND).toHaveLength(1);
        const or = call.where.AND[0].OR;
        const fields = or.map((c: Record<string, unknown>) => Object.keys(c)[0]);
        expect(fields.sort()).toEqual(
          ['black', 'event', 'headline', 'opening', 'site', 'tags', 'title', 'white'].sort(),
        );
        for (const clause of or) {
          const [, cond] = Object.entries(clause)[0] as [
            string,
            { contains: string; mode: 'insensitive' },
          ];
          expect(cond.contains).toBe('Pivovartsev');
          expect(cond.mode).toBe('insensitive');
        }
      });

      it('несколько слов → AND по словам, каждый — OR по полям', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { search: 'Fischer Spassky' });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.where.AND).toHaveLength(2);
        const word1 = call.where.AND[0].OR[0];
        const word2 = call.where.AND[1].OR[0];
        expect(Object.values(word1)[0]).toMatchObject({ contains: 'Fischer' });
        expect(Object.values(word2)[0]).toMatchObject({ contains: 'Spassky' });
      });

      it('search применяется поверх limit/offset/withPgn', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, {
          search: 'fork',
          limit: 50,
          offset: 100,
          withPgn: true,
        });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.take).toBe(50);
        expect(call.skip).toBe(100);
        expect(call.select.pgn).toBe(true);
        expect(call.where.AND).toHaveLength(1);
      });

      it('повторяющиеся пробелы между словами не плодят пустых фильтров', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { search: 'foo    bar' });

        const call = prisma.analysis.findMany.mock.calls[0][0];
        expect(call.where.AND).toHaveLength(2);
      });

      it('tags входит в OR-набор полей (KS-3203)', async () => {
        prisma.analysis.findMany.mockResolvedValue([]);

        await service.findAll(userId, { search: 'endgame' });

        const or = prisma.analysis.findMany.mock.calls[0][0].where.AND[0].OR;
        const tagsClause = or.find(
          (c: Record<string, unknown>) => Object.keys(c)[0] === 'tags',
        );
        expect(tagsClause).toBeDefined();
        expect((tagsClause as any).tags.contains).toBe('endgame');
      });
    });
  });

  describe('findOne', () => {
    it('should return analysis for owner', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);

      const result = await service.findOne(userId, 'analysis-1');

      expect(result).toEqual({ ...mockAnalysis, tags: [] });
    });

    it('should throw NotFoundException when not found', async () => {
      prisma.analysis.findUnique.mockResolvedValue(null);

      await expect(service.findOne(userId, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for wrong user', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);

      await expect(service.findOne(otherId, 'analysis-1')).rejects.toThrow(ForbiddenException);
    });

    // ── KS-2599 (ADR-051 §4 этап A2): GET /analyses/:id корректно
    // отдаёт запись с пустым PGN. После A1 в БД появятся записи с
    // pgn=''; их сериализация должна возвращать pgn:"" (а не null,
    // не подставлять DEFAULT_FEN, не падать на split tags).
    it('KS-2599: findOne возвращает запись с pgn="" без искажений', async () => {
      const empty = {
        ...mockAnalysis,
        id: 'empty-1',
        pgn: '',
        fen: null,
        tags: '',
      };
      prisma.analysis.findUnique.mockResolvedValue(empty);

      const result = await service.findOne(userId, 'empty-1');

      expect(result.pgn).toBe('');
      expect(result.fen).toBeNull();
      expect(result.id).toBe('empty-1');
      expect(result.tags).toEqual([]);
    });

    // ── KS-3724: GET /analyses/:id возвращает сохранённый fen без
    // изменений. Подтверждает, что чтение анализа не подменяет
    // стартовую позицию начальной расстановкой.
    it('KS-3724: findOne возвращает сохранённый произвольный fen', async () => {
      const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
      prisma.analysis.findUnique.mockResolvedValue({ ...mockAnalysis, fen });

      const result = await service.findOne(userId, 'analysis-1');

      expect(result.fen).toBe(fen);
    });
  });

  describe('findPublic (KS-2601)', () => {
    // ── KS-2601 (ADR-051 §3 share-2): публичный read-only доступ.
    //  - isPublic=true  → 200 + проекция без userId.
    //  - isPublic=false → 404 (не светим существование непубличной).
    //  - не найдено     → 404.

    it('KS-2601: возвращает запись без userId, если isPublic=true', async () => {
      const publicAnalysis = {
        ...mockAnalysis,
        id: 'pub-1',
        isPublic: true,
        pgn: '1. e4 c5 *',
        tags: 'sicilian opening',
      };
      prisma.analysis.findUnique.mockResolvedValue(publicAnalysis);

      const result = await service.findPublic('pub-1');

      expect(result.id).toBe('pub-1');
      expect(result.pgn).toBe('1. e4 c5 *');
      expect(result.isPublic).toBe(true);
      expect(result.tags).toEqual(['sicilian', 'opening']);
      // Анонимам не отдаём автора
      expect(result).not.toHaveProperty('userId');
    });

    it('KS-2601: 404 если запись не найдена', async () => {
      prisma.analysis.findUnique.mockResolvedValue(null);

      await expect(service.findPublic('missing')).rejects.toThrow(NotFoundException);
    });

    it('KS-2601: 404 если isPublic=false (не светим непубличную запись)', async () => {
      const privateAnalysis = { ...mockAnalysis, isPublic: false };
      prisma.analysis.findUnique.mockResolvedValue(privateAnalysis);

      await expect(service.findPublic('analysis-1')).rejects.toThrow(NotFoundException);
    });

    it('KS-2601: НЕ проверяет userId — анонимный доступ (нет ForbiddenException)', async () => {
      // запись принадлежит другому пользователю, но isPublic=true
      // → должна отдаться без проверки авторства
      const publicAnalysis = {
        ...mockAnalysis,
        userId: 'other-user',
        isPublic: true,
      };
      prisma.analysis.findUnique.mockResolvedValue(publicAnalysis);

      const result = await service.findPublic('analysis-1');

      expect(result.id).toBe('analysis-1');
      // нет проверки прав → не падает на ForbiddenException
    });
  });

  describe('update', () => {
    it('should update title', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);
      prisma.analysis.update.mockResolvedValue({ ...mockAnalysis, title: 'Updated' });

      await service.update(userId, 'analysis-1', { title: 'Updated' });

      expect(prisma.analysis.update).toHaveBeenCalledWith({
        where: { id: 'analysis-1' },
        data: expect.objectContaining({ title: 'Updated' }),
      });
    });

    it('should throw NotFoundException when not found', async () => {
      prisma.analysis.findUnique.mockResolvedValue(null);

      await expect(service.update(userId, 'nope', { title: 'x' })).rejects.toThrow(NotFoundException);
    });

    // KS-2404: до фикса PATCH с pgn без headers затирал existing
    // event/white/black-поля в null.
    it('KS-2404: PATCH с pgn без headers НЕ сбрасывает существующие headers', async () => {
      const existing = {
        ...mockAnalysis,
        pgn: '[White "Carlsen"]\n[Black "Nepo"]\n[Event "Champ"]\n[Round "5"]\n\n1. e4 e5 *',
        white: 'Carlsen',
        black: 'Nepo',
        event: 'Champ',
        round: '5',
      };
      prisma.analysis.findUnique.mockResolvedValue(existing);
      prisma.analysis.update.mockResolvedValue(existing);

      // moves-only PGN, без headers
      await service.update(userId, 'analysis-1', { pgn: '1. e4 e5 2. Nf3 Nc6 *' });

      const data = prisma.analysis.update.mock.calls[0][0].data;
      // pgn обновился
      expect(data.pgn).toBe('1. e4 e5 2. Nf3 Nc6 *');
      // headers НЕ затёрлись в null — поля просто не передаются в data
      expect(data).not.toHaveProperty('white');
      expect(data).not.toHaveProperty('black');
      expect(data).not.toHaveProperty('event');
      expect(data).not.toHaveProperty('round');
    });

    it('KS-2404: PATCH с pgn с headers — обновляет соответствующие headers', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);
      prisma.analysis.update.mockResolvedValue(mockAnalysis);

      const newPgn =
        '[White "Fischer"]\n[Black "Spassky"]\n[Event "Reykjavik"]\n\n1. e4 c5 *';
      await service.update(userId, 'analysis-1', { pgn: newPgn });

      const data = prisma.analysis.update.mock.calls[0][0].data;
      expect(data.pgn).toBe(newPgn);
      expect(data.white).toBe('Fischer');
      expect(data.black).toBe('Spassky');
      expect(data.event).toBe('Reykjavik');
      // не пришедшие headers НЕ передаются (round, site, opening и т.п.)
      expect(data).not.toHaveProperty('round');
      expect(data).not.toHaveProperty('site');
    });

    // ── KS-3045: PATCH сохраняет boardOrientation. Поле передаётся в
    // data ТОЛЬКО когда ключ явно присутствует в DTO. `null` — валидный
    // ввод (сброс на дефолт). Без ключа — поле не трогаем.
    describe('KS-3045 boardOrientation', () => {
      it('PATCH boardOrientation="black" сохраняет значение', async () => {
        prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);
        prisma.analysis.update.mockResolvedValue({
          ...mockAnalysis,
          boardOrientation: 'black',
        });

        await service.update(userId, 'analysis-1', {
          boardOrientation: 'black',
        });

        const data = prisma.analysis.update.mock.calls[0][0].data;
        expect(data.boardOrientation).toBe('black');
      });

      it('PATCH boardOrientation="white" сохраняет значение', async () => {
        prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);
        prisma.analysis.update.mockResolvedValue({
          ...mockAnalysis,
          boardOrientation: 'white',
        });

        await service.update(userId, 'analysis-1', {
          boardOrientation: 'white',
        });

        const data = prisma.analysis.update.mock.calls[0][0].data;
        expect(data.boardOrientation).toBe('white');
      });

      it('PATCH boardOrientation=null сохраняет null (сброс на дефолт)', async () => {
        prisma.analysis.findUnique.mockResolvedValue({
          ...mockAnalysis,
          boardOrientation: 'black',
        });
        prisma.analysis.update.mockResolvedValue({
          ...mockAnalysis,
          boardOrientation: null,
        });

        await service.update(userId, 'analysis-1', {
          boardOrientation: null,
        });

        const data = prisma.analysis.update.mock.calls[0][0].data;
        expect(data).toHaveProperty('boardOrientation', null);
      });

      it('PATCH без boardOrientation НЕ трогает поле (undefined → не в data)', async () => {
        prisma.analysis.findUnique.mockResolvedValue({
          ...mockAnalysis,
          boardOrientation: 'black',
        });
        prisma.analysis.update.mockResolvedValue(mockAnalysis);

        await service.update(userId, 'analysis-1', { title: 'renamed' });

        const data = prisma.analysis.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('boardOrientation');
      });

      it('findOne возвращает boardOrientation владельцу', async () => {
        prisma.analysis.findUnique.mockResolvedValue({
          ...mockAnalysis,
          boardOrientation: 'black',
        });

        const result = await service.findOne(userId, 'analysis-1');

        expect(result.boardOrientation).toBe('black');
      });

      it('findPublic возвращает boardOrientation третьему лицу', async () => {
        prisma.analysis.findUnique.mockResolvedValue({
          ...mockAnalysis,
          isPublic: true,
          boardOrientation: 'black',
        });

        const result = await service.findPublic('analysis-1');

        expect(result.boardOrientation).toBe('black');
        // публичная проекция, как и раньше, без userId
        expect(result).not.toHaveProperty('userId');
      });
    });
  });

  describe('share (KS-2602)', () => {
    // ── KS-2602 (ADR-051 §3 share-3): автор toggle isPublic.
    //  - автор off→on / on→off,
    //  - чужой → 403,
    //  - не найдено → 404.

    it('KS-2602: автор включает публичность (false → true)', async () => {
      const before = { ...mockAnalysis, isPublic: false };
      const after = { ...mockAnalysis, isPublic: true };
      prisma.analysis.findUnique.mockResolvedValue(before);
      prisma.analysis.update.mockResolvedValue(after);

      const result = await service.share(userId, 'analysis-1', true);

      expect(prisma.analysis.update).toHaveBeenCalledWith({
        where: { id: 'analysis-1' },
        data: { isPublic: true },
      });
      expect(result.isPublic).toBe(true);
      expect(result.tags).toEqual([]);
    });

    it('KS-2602: автор выключает публичность (true → false)', async () => {
      const before = { ...mockAnalysis, isPublic: true };
      const after = { ...mockAnalysis, isPublic: false };
      prisma.analysis.findUnique.mockResolvedValue(before);
      prisma.analysis.update.mockResolvedValue(after);

      const result = await service.share(userId, 'analysis-1', false);

      expect(prisma.analysis.update).toHaveBeenCalledWith({
        where: { id: 'analysis-1' },
        data: { isPublic: false },
      });
      expect(result.isPublic).toBe(false);
    });

    it('KS-2602: чужой пользователь получает ForbiddenException (403)', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);

      await expect(service.share(otherId, 'analysis-1', true)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.analysis.update).not.toHaveBeenCalled();
    });

    it('KS-2602: несуществующая запись — NotFoundException (404)', async () => {
      prisma.analysis.findUnique.mockResolvedValue(null);

      await expect(service.share(userId, 'missing', true)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.analysis.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should delete analysis and return { deleted: true }', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);
      prisma.analysis.delete.mockResolvedValue(mockAnalysis);

      const result = await service.remove(userId, 'analysis-1');

      expect(result).toEqual({ deleted: true });
      expect(prisma.analysis.delete).toHaveBeenCalledWith({ where: { id: 'analysis-1' } });
    });

    it('should throw ForbiddenException for wrong user', async () => {
      prisma.analysis.findUnique.mockResolvedValue(mockAnalysis);

      await expect(service.remove(otherId, 'analysis-1')).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── KS-3602 / ADR-100 §8 — duplicate-annotated ──────────────────────
  describe('duplicateAnnotated (KS-3602)', () => {
    const parentAnalysis = {
      id: 'parent-1',
      userId,
      title: 'My game',
      pgn: '1. e4 e5',
      fen: null,
      opening: 'Open Game',
      event: 'Event',
      site: 'Site',
      pgnDate: '2026.06.01',
      round: '1',
      white: 'Alice',
      black: 'Bob',
      whiteElo: '2000',
      blackElo: '1950',
      result: '1-0',
      category: 'analysis',
      tags: 'foo bar',
      currentPosition: 5,
      boardOrientation: 'white' as 'white' | 'black' | null,
      headline: 'Alice vs Bob, Event',
      isPublic: true,
      sourceHash: 'lichess:abc12345',
      lichessGameId: 'abc12345',
      archiveGameId: null,
      guessSessionId: 'guess-1',
      originalAnalysisId: null,
      lastOpenedAt: new Date('2026-06-01T00:00:00Z'),
      createdAt: new Date('2026-05-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    };
    const annotatedPgn = '1. e4 $1 e5 $2 (1... c5)';

    beforeEach(() => {
      // duplicateAnnotated не использует findUnique — он работает только
      // через findFirst (одновременно проверка владельца). Добавляем mock.
      prisma.analysis.findFirst = jest.fn();
    });

    it('creates new duplicate with originalAnalysisId, suffixed title, reset flags', async () => {
      prisma.analysis.findFirst!
        .mockResolvedValueOnce(parentAnalysis) // load target → parent
        .mockResolvedValueOnce(null);          // existing duplicate? → no
      const createdDup = {
        ...parentAnalysis,
        id: 'dup-1',
        title: 'My game (автоаннотация)',
        pgn: annotatedPgn,
        originalAnalysisId: 'parent-1',
        isPublic: false,
        sourceHash: null,
        guessSessionId: null,
        currentPosition: 0,
      };
      prisma.analysis.create.mockResolvedValue(createdDup);

      const result = await service.duplicateAnnotated(userId, 'parent-1', {
        pgn: annotatedPgn,
      });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId,
          title: 'My game (автоаннотация)',
          pgn: annotatedPgn,
          originalAnalysisId: 'parent-1',
          isPublic: false,
          sourceHash: null,
          guessSessionId: null,
          currentPosition: 0,
          // Унаследованные поля.
          category: 'analysis',
          tags: 'foo bar',
          opening: 'Open Game',
          event: 'Event',
          white: 'Alice',
          black: 'Bob',
          headline: 'Alice vs Bob, Event',
          lichessGameId: 'abc12345',
        }),
      });
      expect(result.id).toBe('dup-1');
      // tags разбиты в массив — shape совпадает с findOne.
      expect(result.tags).toEqual(['foo', 'bar']);
    });

    it('uses default titleSuffix `(автоаннотация)` when not provided', async () => {
      prisma.analysis.findFirst!
        .mockResolvedValueOnce(parentAnalysis)
        .mockResolvedValueOnce(null);
      prisma.analysis.create.mockResolvedValue({
        ...parentAnalysis,
        id: 'dup-1',
        title: 'My game (автоаннотация)',
      });

      await service.duplicateAnnotated(userId, 'parent-1', { pgn: annotatedPgn });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ title: 'My game (автоаннотация)' }),
      });
    });

    it('respects custom titleSuffix', async () => {
      prisma.analysis.findFirst!
        .mockResolvedValueOnce(parentAnalysis)
        .mockResolvedValueOnce(null);
      prisma.analysis.create.mockResolvedValue({
        ...parentAnalysis,
        id: 'dup-1',
        title: 'My game [stockfish v18]',
      });

      await service.duplicateAnnotated(userId, 'parent-1', {
        pgn: annotatedPgn,
        titleSuffix: '[stockfish v18]',
      });

      expect(prisma.analysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ title: 'My game [stockfish v18]' }),
      });
    });

    it('updates existing duplicate (idempotent): same id, new pgn, lastOpenedAt bumped, title untouched', async () => {
      const existingDup = {
        ...parentAnalysis,
        id: 'dup-1',
        title: 'Renamed by user',  // юзер переименовал — не трогаем
        pgn: 'old annotated',
        originalAnalysisId: 'parent-1',
        isPublic: false,
        sourceHash: null,
        guessSessionId: null,
        currentPosition: 0,
      };
      prisma.analysis.findFirst!
        .mockResolvedValueOnce(parentAnalysis) // load target → parent
        .mockResolvedValueOnce(existingDup);   // existing duplicate?
      prisma.analysis.update.mockResolvedValue({
        ...existingDup,
        pgn: annotatedPgn,
      });

      const result = await service.duplicateAnnotated(userId, 'parent-1', {
        pgn: annotatedPgn,
      });

      expect(prisma.analysis.create).not.toHaveBeenCalled();
      expect(prisma.analysis.update).toHaveBeenCalledWith({
        where: { id: 'dup-1' },
        data: { pgn: annotatedPgn, lastOpenedAt: expect.any(Date) },
      });
      expect(result.id).toBe('dup-1');
      expect(result.title).toBe('Renamed by user');
      expect(result.pgn).toBe(annotatedPgn);
    });

    it('on call against own duplicate — resolves to parent and updates duplicate', async () => {
      // Target — это сам дубль. Резолв → parent, потом findFirst по
      // (userId, originalAnalysisId=parent.id) опять найдёт этот же дубль.
      const dupTarget = {
        ...parentAnalysis,
        id: 'dup-1',
        originalAnalysisId: 'parent-1',
        title: 'My game (автоаннотация)',
        isPublic: false,
        sourceHash: null,
      };
      prisma.analysis.findFirst!
        .mockResolvedValueOnce(dupTarget)        // load target (it's a dup)
        .mockResolvedValueOnce(parentAnalysis)   // resolve parent
        .mockResolvedValueOnce(dupTarget);       // existing duplicate? → yes, the same one
      prisma.analysis.update.mockResolvedValue({
        ...dupTarget,
        pgn: annotatedPgn,
      });

      await service.duplicateAnnotated(userId, 'dup-1', { pgn: annotatedPgn });

      // Resolve parent — вторая findFirst по id=parent.id.
      expect(prisma.analysis.findFirst).toHaveBeenNthCalledWith(2, {
        where: { id: 'parent-1', userId },
      });
      // Existing-dup поиск по originalAnalysisId=parent.id.
      expect(prisma.analysis.findFirst).toHaveBeenNthCalledWith(3, {
        where: { userId, originalAnalysisId: 'parent-1' },
      });
      expect(prisma.analysis.update).toHaveBeenCalledWith({
        where: { id: 'dup-1' },
        data: { pgn: annotatedPgn, lastOpenedAt: expect.any(Date) },
      });
    });

    it('on call against orphan duplicate (parent deleted) → 410 Gone', async () => {
      const orphanDup = {
        ...parentAnalysis,
        id: 'dup-1',
        originalAnalysisId: 'parent-deleted',
      };
      prisma.analysis.findFirst!
        .mockResolvedValueOnce(orphanDup) // load target (it's a dup)
        .mockResolvedValueOnce(null);     // resolve parent → not found

      await expect(
        service.duplicateAnnotated(userId, 'dup-1', { pgn: annotatedPgn }),
      ).rejects.toMatchObject({
        status: 410,
        message: expect.stringContaining('Исходный анализ удалён'),
      });
      // 410 — HttpException с конкретным статусом, не NotFound/Forbidden.
      await expect(
        service.duplicateAnnotated(userId, 'dup-1', { pgn: annotatedPgn }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(prisma.analysis.update).not.toHaveBeenCalled();
      expect(prisma.analysis.create).not.toHaveBeenCalled();
    });

    it('on foreign analysis → 404 (hides existence via findFirst+userId)', async () => {
      // findFirst({id, userId}) для чужого вернёт null — это и даёт 404,
      // не светим существование чужого анализа.
      prisma.analysis.findFirst!.mockResolvedValueOnce(null);

      await expect(
        service.duplicateAnnotated(otherId, 'parent-1', { pgn: annotatedPgn }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.analysis.update).not.toHaveBeenCalled();
      expect(prisma.analysis.create).not.toHaveBeenCalled();
    });

    it('on missing analysis (id not in DB) → 404', async () => {
      prisma.analysis.findFirst!.mockResolvedValueOnce(null);

      await expect(
        service.duplicateAnnotated(userId, 'no-such-id', { pgn: annotatedPgn }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
