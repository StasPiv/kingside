/**
 * KS-4674 / ADR-146. Юнит-тесты `OpeningTrainerAdminService` —
 * CRUD над демо-репертуарами (`is_demo=true`). Prisma и builder
 * мокаются.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  OpeningTrainerAdminService,
} from './opening-trainer-admin.service';

function makePrisma() {
  return {
    openingRepertoire: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

function makeBuilder(
  tree: { meta: { nodeCount: number; edgeCount: number; maxDepth: number } } = {
    meta: { nodeCount: 3, edgeCount: 2, maxDepth: 2 },
  },
) {
  return {
    buildTree: jest.fn().mockReturnValue(tree),
  };
}

const ROW_BASE = {
  id: 'rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr',
  slug: 'italian',
  title: 'Italian',
  description: 'desc',
  side: 'white',
  isPublished: false,
  nodeCount: 3,
  edgeCount: 2,
  maxDepth: 2,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  pgn: 'pgn',
  tree: { rootFen: 'x', nodes: {}, meta: { nodeCount: 3, edgeCount: 2, maxDepth: 2 } },
  sources: [
    { id: 's1', pgn: 'pgn', order: 0 },
  ],
};

describe('OpeningTrainerAdminService.list (KS-4674)', () => {
  it('фильтрует только is_demo=true и применяет переданные фильтры', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findMany.mockResolvedValueOnce([]);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await svc.list({ side: 'black', isPublished: true, slug: 'foo' });
    const args = prisma.openingRepertoire.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      isDemo: true,
      side: 'black',
      isPublished: true,
      slug: 'foo',
    });
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
  });

  it('возвращает summary-форму', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findMany.mockResolvedValueOnce([ROW_BASE]);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    const r = await svc.list();
    expect(r).toEqual([
      {
        id: ROW_BASE.id,
        slug: 'italian',
        title: 'Italian',
        description: 'desc',
        side: 'white',
        isPublished: false,
        nodeCount: 3,
        edgeCount: 2,
        maxDepth: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });
});

describe('OpeningTrainerAdminService.getById (KS-4674)', () => {
  it('фильтрует по id И is_demo=true; найдено — detail', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce(ROW_BASE);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    const r = await svc.getById(ROW_BASE.id);
    expect(prisma.openingRepertoire.findFirst.mock.calls[0][0].where).toEqual({
      id: ROW_BASE.id,
      isDemo: true,
    });
    expect(r.id).toBe(ROW_BASE.id);
    expect(r.pgn).toBe('pgn'); // denormalised concat одного source
    expect(r.tree).toBeDefined();
  });

  it('не найдено → 404', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce(null);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await expect(svc.getById('zzzzzzzz-zzzz-4zzz-zzzz-zzzzzzzzzzzz')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('OpeningTrainerAdminService.create (KS-4674)', () => {
  it('создаёт запись с isDemo=true, userId=null, slug; сохраняет один source', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.create.mockResolvedValueOnce(ROW_BASE);
    const builder = makeBuilder();
    const svc = new OpeningTrainerAdminService(prisma as never, builder as never);
    await svc.create({
      slug: 'italian',
      title: 'Italian',
      description: 'desc',
      side: 'white',
      pgn: '[Event "Italian"]\n\n1. e4 e5 *',
    });
    const data = prisma.openingRepertoire.create.mock.calls[0][0].data;
    expect(data.isDemo).toBe(true);
    expect(data.userId).toBeNull();
    expect(data.slug).toBe('italian');
    expect(data.isPublished).toBe(false);
    expect(data.sources.create.sourceKind).toBe('legacy-import');
    // KS-4674: OpeningRepertoireSource не имеет колонки `order` — порядок
    // задаётся `createdAt` (см. orderBy в admin-сервисе).
  });

  it('isPublished=true → пишет true', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.create.mockResolvedValueOnce(ROW_BASE);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await svc.create({
      slug: 'p',
      title: 't',
      side: 'white',
      pgn: 'p',
      isPublished: true,
    });
    expect(prisma.openingRepertoire.create.mock.calls[0][0].data.isPublished).toBe(true);
  });

  it('P2002 от Prisma → ConflictException (slug коллизия)', async () => {
    const prisma = makePrisma();
    // Prisma-ошибка маппится по `.code` (duck-typing — см. mapPrismaError).
    prisma.openingRepertoire.create.mockRejectedValueOnce({ code: 'P2002' });
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await expect(
      svc.create({ slug: 'dup', title: 't', side: 'white', pgn: 'p' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OpeningTrainerAdminService.update (KS-4674)', () => {
  it('PUT без pgn — не пересобирает дерево, обновляет только указанные поля', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce({
      id: ROW_BASE.id,
      sources: [{ id: 's1' }],
    });
    prisma.openingRepertoire.update.mockResolvedValueOnce(ROW_BASE);
    const builder = makeBuilder();
    const svc = new OpeningTrainerAdminService(prisma as never, builder as never);
    await svc.update(ROW_BASE.id, { title: 'NewTitle' });
    expect(builder.buildTree).not.toHaveBeenCalled();
    expect(prisma.openingRepertoire.update.mock.calls[0][0].data).toEqual({
      title: 'NewTitle',
    });
  });

  it('PUT c pgn — пересобирает tree и пишет sources.update', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce({
      id: ROW_BASE.id,
      sources: [{ id: 's1' }],
    });
    prisma.openingRepertoire.update.mockResolvedValueOnce(ROW_BASE);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await svc.update(ROW_BASE.id, { pgn: 'new-pgn', title: 'New' });
    const data = prisma.openingRepertoire.update.mock.calls[0][0].data;
    expect(data.pgn).toBe('new-pgn');
    expect(data.tree).toBeDefined();
    expect(data.nodeCount).toBe(3);
    expect(data.sources.update.where.id).toBe('s1');
    expect(data.sources.update.data.pgn).toBe('new-pgn');
  });

  it('не найден → 404', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce(null);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await expect(
      svc.update(ROW_BASE.id, { title: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OpeningTrainerAdminService.setStatus (KS-4674)', () => {
  it('меняет isPublished для существующего демо', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce({ id: ROW_BASE.id });
    prisma.openingRepertoire.update.mockResolvedValueOnce({
      ...ROW_BASE,
      isPublished: true,
    });
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    const r = await svc.setStatus(ROW_BASE.id, { isPublished: true });
    expect(r.isPublished).toBe(true);
    expect(prisma.openingRepertoire.update.mock.calls[0][0].data).toEqual({
      isPublished: true,
    });
  });

  it('не найден → 404', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce(null);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await expect(
      svc.setStatus(ROW_BASE.id, { isPublished: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OpeningTrainerAdminService.delete (KS-4674)', () => {
  it('hard-delete существующего демо', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce({
      id: ROW_BASE.id,
      slug: 'italian',
    });
    prisma.openingRepertoire.delete.mockResolvedValueOnce({});
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await svc.delete(ROW_BASE.id);
    expect(prisma.openingRepertoire.delete).toHaveBeenCalledWith({
      where: { id: ROW_BASE.id },
    });
  });

  it('не найден → 404, delete не вызван', async () => {
    const prisma = makePrisma();
    prisma.openingRepertoire.findFirst.mockResolvedValueOnce(null);
    const svc = new OpeningTrainerAdminService(prisma as never, makeBuilder() as never);
    await expect(svc.delete(ROW_BASE.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.openingRepertoire.delete).not.toHaveBeenCalled();
  });
});
