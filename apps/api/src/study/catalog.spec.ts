/**
 * KS-2885 / ADR-060 §10.2 B12. Acceptance-тесты `StudyService.catalog()`.
 *
 * Дополняют существующий `study.service.spec.ts` фокусным покрытием
 * по KS-2885: каждая ветка sort, фильтры q+topic, пагинация, edge —
 * пустой результат / последняя страница / сверхбольшой pageSize.
 *
 * Намеренно изолированы от других describe-блоков: spec-файл с
 * указанным в B12 именем (`catalog.spec.ts`) — единая точка входа
 * для CI/coverage отчёта по фиче «catalog».
 */
import { StudyService } from './study.service';
import { StudyCatalogController } from './study-catalog.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { StudySlugService } from './study-slug.service';
import type { StudyCatalogQueryDto } from './dto/study.dto';

function makePrisma(): any {
  return {
    study: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return arg({});
      return arg;
    }),
  };
}

function makeSlug(): any {
  return { generateUnique: jest.fn(), generate: jest.fn() };
}

function makeMembers(): any {
  return { getRole: jest.fn(async () => null) };
}

const baseStudy = {
  id: '33333333-3333-4333-a333-333333333333',
  ownerId: '11111111-1111-4111-a111-111111111111',
  slug: 'abc-study',
  name: 'Study',
  description: null,
  isPublic: true,
  visibility: 'public',
  topics: [],
  likes: 0,
  fromKind: 'scratch',
  fromRefId: null,
  chaptersCount: 0,
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-02T00:00:00Z'),
};

describe('KS-2885 B12 · StudyService.catalog', () => {
  let prisma: any;
  let svc: StudyService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new StudyService(
      prisma as unknown as PrismaService,
      makeSlug() as unknown as StudySlugService,
      makeMembers(),
    );
  });

  describe('sort variants', () => {
    it('sort=hot (default) → $queryRawUnsafe с PG-формулой и GREATEST-защитой', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([{ id: baseStudy.id }]);
      prisma.study.findMany.mockResolvedValue([baseStudy]);
      prisma.study.count.mockResolvedValue(1);

      const r = await svc.catalog({});

      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      const sql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
      // Защита от деления на 0 для свежих студий — `GREATEST(..., 1)`
      expect(sql).toMatch(/GREATEST\(EXTRACT\(EPOCH FROM \(NOW\(\) - s\.created_at\)\), 1\)/);
      // Tie-break по updated_at DESC.
      expect(sql).toMatch(/ORDER BY[\s\S]+DESC, s\.updated_at DESC/);
      expect(r.items[0].id).toBe(baseStudy.id);
    });

    it('sort=new → orderBy createdAt desc', async () => {
      await svc.catalog({ sort: 'new' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }]);
    });

    it('sort=updated → orderBy updatedAt desc', async () => {
      await svc.catalog({ sort: 'updated' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ updatedAt: 'desc' }]);
    });

    it('sort=popular → orderBy likes desc, updatedAt desc (tie-break)', async () => {
      await svc.catalog({ sort: 'popular' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ likes: 'desc' }, { updatedAt: 'desc' }]);
    });

    it('hot: dual-query сохраняет порядок id из raw-результата', async () => {
      const a = { ...baseStudy, id: 'aaa' };
      const b = { ...baseStudy, id: 'bbb' };
      const c = { ...baseStudy, id: 'ccc' };
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 'ccc' },
        { id: 'aaa' },
        { id: 'bbb' },
      ]);
      // Намеренно отдаём в обратном порядке — сервис обязан восстановить.
      prisma.study.findMany.mockResolvedValue([a, b, c]);
      prisma.study.count.mockResolvedValue(3);

      const r = await svc.catalog({ sort: 'hot' });

      expect(r.items.map((s) => s.id)).toEqual(['ccc', 'aaa', 'bbb']);
    });
  });

  describe('filters: q + topic', () => {
    it('q добавляет OR ILIKE name+description (insensitive)', async () => {
      await svc.catalog({ sort: 'new', q: 'sicilian' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({
        visibility: 'public',
        OR: [
          { name: { contains: 'sicilian', mode: 'insensitive' } },
          { description: { contains: 'sicilian', mode: 'insensitive' } },
        ],
      });
    });

    it('q whitespace → НЕ добавляет OR', async () => {
      await svc.catalog({ sort: 'new', q: '   ' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({ visibility: 'public' });
    });

    it('topic добавляет topics.has', async () => {
      await svc.catalog({ sort: 'new', topic: 'opening' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({
        visibility: 'public',
        topics: { has: 'opening' },
      });
    });

    it('q + topic — комбинация без потери visibility=public', async () => {
      await svc.catalog({ sort: 'popular', q: 'caro-kann', topic: 'opening' });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({
        visibility: 'public',
        OR: [
          { name: { contains: 'caro-kann', mode: 'insensitive' } },
          { description: { contains: 'caro-kann', mode: 'insensitive' } },
        ],
        topics: { has: 'opening' },
      });
    });

    it('hot: q+topic — SQL содержит ILIKE и `topics @>` с параметризацией', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      await svc.catalog({ sort: 'hot', q: 'sicilian', topic: 'opening' });
      const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
      expect(sql).toMatch(/ILIKE \$1[\s\S]+ILIKE \$2/);
      expect(sql).toMatch(/s\.topics @> ARRAY\[\$3\]::text\[\]/);
      expect(params).toEqual(['%sicilian%', '%sicilian%', 'opening', 20, 0]);
    });
  });

  describe('пагинация', () => {
    it('page=2 pageSize=10 → skip=10 take=10', async () => {
      await svc.catalog({ sort: 'new', page: 2, pageSize: 10 });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.skip).toBe(10);
      expect(call.take).toBe(10);
    });

    it('pageSize клампится до max=50', async () => {
      await svc.catalog({ sort: 'new', page: 1, pageSize: 999 });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(50);
    });

    it('page=0 → clampInt(1, …) → skip=0', async () => {
      await svc.catalog({ sort: 'new', page: 0, pageSize: 20 });
      const call = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(call.skip).toBe(0);
    });

    it('hasMore=true когда skip + items.length < total', async () => {
      prisma.study.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({ ...baseStudy, id: `id-${i}` })),
      );
      prisma.study.count.mockResolvedValue(45);

      const r = await svc.catalog({ sort: 'new', page: 1, pageSize: 20 });

      expect(r.total).toBe(45);
      expect(r.items).toHaveLength(20);
      expect(r.hasMore).toBe(true);
    });

    it('hasMore=false на последней странице', async () => {
      prisma.study.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ ...baseStudy, id: `id-${i}` })),
      );
      prisma.study.count.mockResolvedValue(25);

      const r = await svc.catalog({ sort: 'new', page: 2, pageSize: 20 });

      expect(r.hasMore).toBe(false);
    });
  });

  describe('edge: пустой результат', () => {
    it('sort=new, нет совпадений → items=[], total=0, hasMore=false', async () => {
      prisma.study.findMany.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);

      const r = await svc.catalog({ sort: 'new', q: 'nonexistent-token-xyz' });

      expect(r.items).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.hasMore).toBe(false);
    });

    it('sort=hot, пустой raw-результат → findMany не вызывается', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);

      const r = await svc.catalog({ sort: 'hot' });

      expect(r.items).toEqual([]);
      expect(prisma.study.findMany).not.toHaveBeenCalled();
    });
  });

  describe('visibility инвариант (KS-2910)', () => {
    it('catalog никогда не отдаёт unlisted/private — `where.visibility=public` всегда', async () => {
      await svc.catalog({ sort: 'new' });
      const findManyCall = (prisma.study.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.visibility).toBe('public');

      // count тоже фильтрует по public.
      const countCall = (prisma.study.count as jest.Mock).mock.calls[0][0];
      expect(countCall.where.visibility).toBe('public');
    });
  });
});

describe('KS-2885 B12 · StudyCatalogController', () => {
  it('GET /studies/catalog проксирует query в StudyService.catalog', async () => {
    const expected = {
      items: [],
      total: 0,
      hasMore: false,
    };
    const fakeService = {
      catalog: jest.fn().mockResolvedValue(expected),
    } as unknown as StudyService;
    const controller = new StudyCatalogController(fakeService);

    const query: StudyCatalogQueryDto = {
      sort: 'hot',
      q: 'sicilian',
      topic: 'opening',
      page: 2,
      pageSize: 10,
    };
    const r = await controller.catalog(query);

    expect((fakeService.catalog as jest.Mock)).toHaveBeenCalledWith(query);
    expect(r).toBe(expected);
  });

  it('пустой query тоже передаётся в сервис (defaults применяет сервис)', async () => {
    const fakeService = {
      catalog: jest.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
    } as unknown as StudyService;
    const controller = new StudyCatalogController(fakeService);

    await controller.catalog({} as StudyCatalogQueryDto);

    expect((fakeService.catalog as jest.Mock)).toHaveBeenCalledWith({});
  });
});
