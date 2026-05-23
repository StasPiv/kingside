import { OpeningTrainerRepository } from './opening-trainer.repository';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * KS-3270. Repo-уровень CRUD-тесты (мокаем Prisma — без реальной БД).
 * Цель — зафиксировать контракт «что вызывается с какими аргументами»,
 * чтобы будущие изменения в сервисном слое сразу подсветили регрессии
 * в repository-вызовах.
 *
 * Полные интеграционные CRUD против настоящей Postgres-фикстуры — в
 * KS-3272 (вместе с endpoint-тестами через TestingModule).
 */

function makePrisma() {
  return {
    openingRepertoire: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'r-1' }),
      update: jest.fn().mockResolvedValue({ id: 'r-1' }),
    },
    openingTrainerSession: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 's-1' }),
      update: jest.fn().mockResolvedValue({ id: 's-1' }),
    },
    openingTrainerAttempt: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'a-1' }),
    },
  } as unknown as PrismaService & Record<string, never>;
}

function makeRepo(prisma: ReturnType<typeof makePrisma>): OpeningTrainerRepository {
  return new OpeningTrainerRepository(prisma as unknown as PrismaService);
}

const SAMPLE_TREE = {
  rootFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  nodes: {},
  meta: { nodeCount: 0, edgeCount: 0, maxDepth: 0 },
};

describe('OpeningTrainerRepository', () => {
  describe('listRepertoires', () => {
    it('фильтрует deletedAt=null + сортирует createdAt DESC + default limit 50', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.listRepertoires('u-1');

      expect(prisma.openingRepertoire.findMany).toHaveBeenCalledWith({
        where: { userId: 'u-1', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        skip: 0,
      });
    });

    it('пробрасывает take/skip', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.listRepertoires('u-1', { take: 5, skip: 10 });

      expect(prisma.openingRepertoire.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 10 }),
      );
    });
  });

  describe('findRepertoireById', () => {
    it('НЕ фильтрует soft-deleted (для 410 Gone семантики)', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.findRepertoireById('r-1');

      expect(prisma.openingRepertoire.findUnique).toHaveBeenCalledWith({
        where: { id: 'r-1' },
      });
    });
  });

  describe('countRepertoiresByUser', () => {
    it('считает только активные (для проверки 50-лимита)', async () => {
      const prisma = makePrisma();
      (prisma.openingRepertoire.count as jest.Mock).mockResolvedValue(7);
      const repo = makeRepo(prisma);

      const n = await repo.countRepertoiresByUser('u-1');

      expect(prisma.openingRepertoire.count).toHaveBeenCalledWith({
        where: { userId: 'u-1', deletedAt: null },
      });
      expect(n).toBe(7);
    });
  });

  describe('createRepertoire', () => {
    it('сохраняет tree, метаданные и nullable description', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.createRepertoire({
        userId: 'u-1',
        title: 'Caro-Kann',
        description: 'Repertoire for black',
        pgn: '1.e4 c6 2.d4 d5',
        tree: SAMPLE_TREE,
        nodeCount: 5,
        edgeCount: 4,
        maxDepth: 4,
      });

      expect(prisma.openingRepertoire.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-1',
          title: 'Caro-Kann',
          description: 'Repertoire for black',
          pgn: '1.e4 c6 2.d4 d5',
          tree: SAMPLE_TREE,
          nodeCount: 5,
          edgeCount: 4,
          maxDepth: 4,
        },
      });
    });

    it('default description = null если не задан', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.createRepertoire({
        userId: 'u-1',
        title: 'Caro-Kann',
        pgn: '1.e4 c6',
        tree: SAMPLE_TREE,
        nodeCount: 1,
        edgeCount: 1,
        maxDepth: 1,
      });

      expect(prisma.openingRepertoire.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ description: null }),
        }),
      );
    });
  });

  describe('updateRepertoire', () => {
    it('обновляет частично — только переданные поля', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.updateRepertoire('r-1', { title: 'New title' });

      expect(prisma.openingRepertoire.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { title: 'New title' },
      });
    });
  });

  describe('softDeleteRepertoire', () => {
    it('проставляет deletedAt без удаления записи', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);
      const fixedNow = new Date('2026-05-23T12:00:00Z');

      await repo.softDeleteRepertoire('r-1', fixedNow);

      expect(prisma.openingRepertoire.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { deletedAt: fixedNow },
      });
    });
  });

  describe('createSession', () => {
    it('default repeatMode=complete + status=active + пустые playedLines/path', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.createSession({
        userId: 'u-1',
        repertoireId: 'r-1',
        side: 'white',
        mode: 'learn',
        currentFen:
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      });

      expect(prisma.openingTrainerSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u-1',
          repertoireId: 'r-1',
          side: 'white',
          mode: 'learn',
          repeatMode: 'complete',
          status: 'active',
          playedLines: {},
          currentPath: [],
        }),
      });
    });

    it('repeatMode=cycle пробрасывается явно', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.createSession({
        userId: 'u-1',
        repertoireId: 'r-1',
        side: 'black',
        mode: 'free',
        repeatMode: 'cycle',
        currentFen: 'fen',
      });

      expect(prisma.openingTrainerSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ repeatMode: 'cycle' }),
        }),
      );
    });
  });

  describe('countActiveSessionsByUser', () => {
    it('считает status=active (не finished/expired)', async () => {
      const prisma = makePrisma();
      (prisma.openingTrainerSession.count as jest.Mock).mockResolvedValue(2);
      const repo = makeRepo(prisma);

      const n = await repo.countActiveSessionsByUser('u-1');

      expect(prisma.openingTrainerSession.count).toHaveBeenCalledWith({
        where: { userId: 'u-1', status: 'active' },
      });
      expect(n).toBe(2);
    });
  });

  describe('updateSession', () => {
    it('пробрасывает все опц. поля', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);
      const finishedAt = new Date('2026-05-23T13:00:00Z');

      await repo.updateSession('s-1', {
        status: 'finished',
        score: 50,
        movesPlayed: 10,
        correctMoves: 8,
        wrongMoves: 2,
        finishedAt,
      });

      expect(prisma.openingTrainerSession.update).toHaveBeenCalledWith({
        where: { id: 's-1' },
        data: {
          status: 'finished',
          score: 50,
          movesPlayed: 10,
          correctMoves: 8,
          wrongMoves: 2,
          finishedAt,
        },
      });
    });
  });

  describe('createAttempt', () => {
    it('default hintUsed=false', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.createAttempt({
        sessionId: 's-1',
        positionFen: 'fen',
        expectedMoves: ['e2e4'],
        userMove: 'e2e4',
        correct: true,
        scoreDelta: 10,
        responseTimeMs: 1500,
      });

      expect(prisma.openingTrainerAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          hintUsed: false,
          correct: true,
          scoreDelta: 10,
        }),
      });
    });

    it('hintUsed=true пробрасывается', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.createAttempt({
        sessionId: 's-1',
        positionFen: 'fen',
        expectedMoves: ['e2e4'],
        userMove: 'e2e4',
        correct: true,
        hintUsed: true,
        scoreDelta: 5,
        responseTimeMs: 8000,
      });

      expect(prisma.openingTrainerAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ hintUsed: true, scoreDelta: 5 }),
        }),
      );
    });
  });

  describe('listAttemptsBySession', () => {
    it('orderBy createdAt asc', async () => {
      const prisma = makePrisma();
      const repo = makeRepo(prisma);

      await repo.listAttemptsBySession('s-1');

      expect(prisma.openingTrainerAttempt.findMany).toHaveBeenCalledWith({
        where: { sessionId: 's-1' },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('countAttemptsBySession', () => {
    it('считает по sessionId', async () => {
      const prisma = makePrisma();
      (prisma.openingTrainerAttempt.count as jest.Mock).mockResolvedValue(15);
      const repo = makeRepo(prisma);

      const n = await repo.countAttemptsBySession('s-1');

      expect(prisma.openingTrainerAttempt.count).toHaveBeenCalledWith({
        where: { sessionId: 's-1' },
      });
      expect(n).toBe(15);
    });
  });
});
