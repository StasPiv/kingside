import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkshopService } from './workshop.service';

describe('WorkshopService', () => {
  let service: WorkshopService;
  let prisma: {
    pgnImport: { create: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
    pgnImportGame: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock; createMany: jest.Mock };
  };

  const userId = 'user-1';

  beforeEach(() => {
    prisma = {
      pgnImport: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      pgnImportGame: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn(), createMany: jest.fn() },
    };
    service = new WorkshopService(prisma as any);
  });

  describe('importPgn', () => {
    it('should throw if no file provided', async () => {
      await expect(service.importPgn(userId, null as any)).rejects.toThrow(BadRequestException);
    });

    it('should throw if PGN has no games', async () => {
      const file = {
        buffer: Buffer.from(''),
        originalname: 'empty.pgn',
      } as Express.Multer.File;

      await expect(service.importPgn(userId, file)).rejects.toThrow(BadRequestException);
    });

    it('should import valid PGN file', async () => {
      const pgn = '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n';
      const file = {
        buffer: Buffer.from(pgn),
        originalname: 'game.pgn',
      } as Express.Multer.File;

      prisma.pgnImport.create.mockResolvedValue({
        id: 'import-1',
        fileName: 'game',
        createdAt: new Date(),
        _count: { games: 1 },
      });

      const result = await service.importPgn(userId, file);

      expect(result.fileName).toBe('game');
      expect(result.gamesCount).toBe(1);
      expect(prisma.pgnImport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId, fileName: 'game' }),
        }),
      );
    });

    it('should add only new games on re-import with same fileName', async () => {
      const existingGames = [
        { pgn: '[White "Alice"]\n[Black "Bob"]\n[Date "2026.03.01"]\n[Result "1-0"]\n\n1. e4 e5 1-0' },
      ];

      prisma.pgnImport.findFirst.mockResolvedValue({
        id: 'existing-import',
        fileName: 'game',
        createdAt: new Date(),
        games: existingGames,
      });

      prisma.pgnImportGame.count.mockResolvedValue(2);
      prisma.pgnImportGame.aggregate.mockResolvedValue({ _max: { position: 0 } });
      prisma.pgnImportGame.createMany.mockResolvedValue({ count: 1 });

      // Re-import with same game + one new
      const pgn = '[White "Alice"]\n[Black "Bob"]\n[Date "2026.03.01"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n[White "Eve"]\n[Black "Frank"]\n[Date "2026.03.03"]\n[Result "0-1"]\n\n1. d4 d5 0-1';
      const file = {
        buffer: Buffer.from(pgn),
        originalname: 'game.pgn',
      } as Express.Multer.File;

      const result = await service.importPgn(userId, file);

      expect(result.id).toBe('existing-import');
      expect(result.added).toBe(1);
      expect(prisma.pgnImportGame.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ white: 'Eve', black: 'Frank' }),
          ]),
        }),
      );
      // Should NOT create a new PgnImport
      expect(prisma.pgnImport.create).not.toHaveBeenCalled();
    });

    it('should return added: 0 when all games are duplicates', async () => {
      const existingGames = [
        { pgn: '[White "Alice"]\n[Black "Bob"]\n[Date "2026.03.01"]\n[Result "1-0"]\n\n1. e4 e5 1-0' },
      ];

      prisma.pgnImport.findFirst.mockResolvedValue({
        id: 'existing-import',
        fileName: 'game',
        createdAt: new Date(),
        games: existingGames,
      });

      prisma.pgnImportGame.count.mockResolvedValue(1);

      const pgn = '[White "Alice"]\n[Black "Bob"]\n[Date "2026.03.01"]\n[Result "1-0"]\n\n1. e4 e5 1-0';
      const file = {
        buffer: Buffer.from(pgn),
        originalname: 'game.pgn',
      } as Express.Multer.File;

      const result = await service.importPgn(userId, file);

      expect(result.id).toBe('existing-import');
      expect(result.added).toBe(0);
      expect(prisma.pgnImport.create).not.toHaveBeenCalled();
    });
  });

  describe('findAllImports', () => {
    it('should return imports ordered by date desc', async () => {
      prisma.pgnImport.findMany.mockResolvedValue([
        { id: 'i1', fileName: 'game1', createdAt: new Date(), _count: { games: 3 } },
      ]);

      const result = await service.findAllImports(userId);

      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('game1');
      expect(result[0].gamesCount).toBe(3);
    });
  });

  describe('findImportGames', () => {
    it('should return games for import owner', async () => {
      prisma.pgnImport.findUnique.mockResolvedValue({ id: 'i1', userId });
      prisma.pgnImportGame.findMany.mockResolvedValue([
        { id: 'g1', white: 'Alice', black: 'Bob', result: '1-0', position: 0 },
      ]);

      const result = await service.findImportGames(userId, 'i1');

      expect(result).toHaveLength(1);
    });

    it('should throw NotFoundException when import not found', async () => {
      prisma.pgnImport.findUnique.mockResolvedValue(null);

      await expect(service.findImportGames(userId, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for wrong user', async () => {
      prisma.pgnImport.findUnique.mockResolvedValue({ id: 'i1', userId: 'other' });

      await expect(service.findImportGames(userId, 'i1')).rejects.toThrow(ForbiddenException);
    });
  });
});
