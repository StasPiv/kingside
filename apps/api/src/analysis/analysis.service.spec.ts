import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnalysisService } from './analysis.service';

describe('AnalysisService', () => {
  let service: AnalysisService;
  let prisma: {
    analysis: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
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
        update: jest.fn(),
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

    it('KS-2598 регрессия: непустой PGN сохраняется без изменений', async () => {
      prisma.analysis.create.mockResolvedValue(mockAnalysis);
      const pgn = '[White "Carlsen"]\n[Black "Nepo"]\n\n1. e4 c5 *';

      await service.create(userId, { pgn });

      const data = prisma.analysis.create.mock.calls[0][0].data;
      expect(data.pgn).toBe(pgn);
      expect(data.white).toBe('Carlsen');
      expect(data.black).toBe('Nepo');
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
    it('should return analyses for user ordered by date desc', async () => {
      prisma.analysis.findMany.mockResolvedValue([mockAnalysis]);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      expect(prisma.analysis.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          orderBy: { createdAt: 'desc' },
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
});
