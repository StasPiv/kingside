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
