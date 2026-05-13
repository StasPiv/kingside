/**
 * KS-2924 / KS-2927 Phase A3. Юнит-тесты `SavedFiltersService`.
 *
 * Покрываются: list-по-section, лимит 20 на (user, section),
 * дубль имени → 409, ownership 404 на PATCH/DELETE, нормализация
 * params (workshop + archive ветки), маппинг dto (подмешивание
 * section в params на чтении, отрезание section при записи).
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_FILTERS_PER_SECTION,
  SavedFiltersService,
  toSavedFilterDto,
} from './saved-filters.service';
import type { PrismaService } from '../../prisma/prisma.service';

const userId = 'user-1';
const otherUserId = 'user-2';

function makePrisma(): any {
  return {
    savedFilter: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

function rowOf(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides.id ?? 'sf-1',
    userId: overrides.userId ?? userId,
    section: overrides.section ?? 'workshop',
    name: overrides.name ?? 'My filter',
    params: overrides.params ?? {},
    category: null,
    tags: null,
    search: null,
    sortOrder: null,
    createdAt: new Date('2026-05-13T08:00:00Z'),
    updatedAt: new Date('2026-05-13T08:30:00Z'),
    ...overrides,
  };
}

describe('SavedFiltersService — KS-2927', () => {
  let prisma: any;
  let svc: SavedFiltersService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new SavedFiltersService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('фильтрует по userId и section, sort createdAt desc', async () => {
      const rows = [rowOf({ id: 'a' }), rowOf({ id: 'b' })];
      prisma.savedFilter.findMany.mockResolvedValue(rows);
      const r = await svc.list(userId, 'workshop');
      expect(prisma.savedFilter.findMany).toHaveBeenCalledWith({
        where: { userId, section: 'workshop' },
        orderBy: { createdAt: 'desc' },
      });
      expect(r).toHaveLength(2);
      expect(r[0].section).toBe('workshop');
      // section подмешан в params
      expect((r[0].params as Record<string, unknown>).section).toBe(
        'workshop',
      );
    });
  });

  describe('create', () => {
    it('workshop: нормализует params и пишет без section в JSONB', async () => {
      prisma.savedFilter.count.mockResolvedValue(0);
      prisma.savedFilter.findFirst.mockResolvedValue(null);
      prisma.savedFilter.create.mockImplementation(({ data }: any) =>
        Promise.resolve(rowOf({ ...data, id: 'new' })),
      );

      const dto = {
        section: 'workshop' as const,
        name: '  Испанская  ',
        params: {
          // section внутри JSON будет отрезан перед записью
          section: 'workshop',
          category: 'opening',
          tags: ['italian', 'spanish'],
          search: 'e4',
          sortOrder: 'newest',
          unknownField: 'dropped',
        },
      };
      const r = await svc.create(userId, dto as never);

      expect(prisma.savedFilter.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId,
          section: 'workshop',
          name: 'Испанская', // trim
          params: {
            category: 'opening',
            tags: ['italian', 'spanish'],
            search: 'e4',
            sortOrder: 'newest',
          },
        }),
      });
      expect(r.section).toBe('workshop');
      expect((r.params as Record<string, unknown>).section).toBe('workshop');
    });

    it('archive: нормализует params (массивы, nullable, enum)', async () => {
      prisma.savedFilter.count.mockResolvedValue(0);
      prisma.savedFilter.findFirst.mockResolvedValue(null);
      prisma.savedFilter.create.mockImplementation(({ data }: any) =>
        Promise.resolve(
          rowOf({ ...data, section: 'archive', id: 'arch-1' }),
        ),
      );

      const dto = {
        section: 'archive' as const,
        name: 'Carlsen blitz',
        params: {
          players: ['Carlsen'],
          event: 'Titled Tuesday',
          eco: 'B90',
          result: '1-0',
          minElo: 2700,
          since: '2026-01-01',
          until: null,
          minPly: 20,
          maxPly: null,
          timeControlCategory: ['blitz', 'bullet'],
          sort: 'topElo',
        },
      };
      await svc.create(userId, dto as never);
      const createdData = (prisma.savedFilter.create as jest.Mock).mock
        .calls[0][0].data;
      expect(createdData.params).toEqual({
        players: ['Carlsen'],
        event: 'Titled Tuesday',
        eco: 'B90',
        result: '1-0',
        minElo: 2700,
        since: '2026-01-01',
        until: null,
        minPly: 20,
        maxPly: null,
        timeControlCategory: ['blitz', 'bullet'],
        sort: 'topElo',
      });
    });

    it('archive: невалидный enum в timeControlCategory → 400', async () => {
      prisma.savedFilter.count.mockResolvedValue(0);
      prisma.savedFilter.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(userId, {
          section: 'archive',
          name: 'X',
          params: { timeControlCategory: ['bullet', 'invalid'] },
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.savedFilter.create).not.toHaveBeenCalled();
    });

    it('лимит 20 на (user, section) → 400', async () => {
      prisma.savedFilter.count.mockResolvedValue(MAX_FILTERS_PER_SECTION);
      await expect(
        svc.create(userId, {
          section: 'workshop',
          name: 'X',
          params: {},
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.savedFilter.create).not.toHaveBeenCalled();
    });

    it('дубль имени в (user, section) → 409', async () => {
      prisma.savedFilter.count.mockResolvedValue(3);
      prisma.savedFilter.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(
        svc.create(userId, {
          section: 'workshop',
          name: 'Spanish',
          params: {},
        } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.savedFilter.findFirst).toHaveBeenCalledWith({
        where: { userId, section: 'workshop', name: 'Spanish' },
        select: { id: true },
      });
      expect(prisma.savedFilter.create).not.toHaveBeenCalled();
    });

    it('пустое имя после trim → 400', async () => {
      await expect(
        svc.create(userId, {
          section: 'workshop',
          name: '    ',
          params: {},
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('params не объект → 400', async () => {
      await expect(
        svc.create(userId, {
          section: 'workshop',
          name: 'X',
          params: ['array'],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('чужая запись → 404 (ownership-чек)', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(
        rowOf({ userId: otherUserId }),
      );
      await expect(
        svc.update(userId, 'sf-1', { name: 'New' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.savedFilter.update).not.toHaveBeenCalled();
    });

    it('несуществующая запись → 404', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(null);
      await expect(
        svc.update(userId, 'sf-x', { name: 'New' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('переименование с дублем имени → 409', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(rowOf());
      prisma.savedFilter.findFirst.mockResolvedValue({ id: 'other' });
      await expect(
        svc.update(userId, 'sf-1', { name: 'Other' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      // Поиск дубля исключает текущую запись.
      expect(prisma.savedFilter.findFirst).toHaveBeenCalledWith({
        where: {
          userId,
          section: 'workshop',
          name: 'Other',
          NOT: { id: 'sf-1' },
        },
        select: { id: true },
      });
    });

    it('переименование на текущее имя не считается дублем', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(
        rowOf({ name: 'Same' }),
      );
      // findFirst пустой — поиск с NOT { id: current } не нашёл других.
      prisma.savedFilter.findFirst.mockResolvedValue(null);
      prisma.savedFilter.update.mockResolvedValue(rowOf({ name: 'Same' }));
      await expect(
        svc.update(userId, 'sf-1', { name: 'Same' } as never),
      ).resolves.toBeDefined();
    });

    it('частичный update params использует section из существующей записи', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(
        rowOf({ section: 'archive' }),
      );
      prisma.savedFilter.update.mockImplementation(({ data }: any) =>
        Promise.resolve(rowOf({ section: 'archive', params: data.params })),
      );
      const r = await svc.update(userId, 'sf-1', {
        params: { players: ['Carlsen'], timeControlCategory: ['blitz'] },
      } as never);
      const updateCall = (prisma.savedFilter.update as jest.Mock).mock
        .calls[0][0];
      expect(updateCall.data.params.players).toEqual(['Carlsen']);
      expect(updateCall.data.params.timeControlCategory).toEqual(['blitz']);
      // section в БД-JSONB не пишется
      expect(updateCall.data.params.section).toBeUndefined();
      expect(r.section).toBe('archive');
      expect((r.params as Record<string, unknown>).section).toBe('archive');
    });

    it('пустой dto → возвращает текущее состояние без update', async () => {
      const existing = rowOf();
      prisma.savedFilter.findUnique.mockResolvedValue(existing);
      const r = await svc.update(userId, 'sf-1', {} as never);
      expect(prisma.savedFilter.update).not.toHaveBeenCalled();
      expect(r.id).toBe(existing.id);
    });
  });

  describe('remove', () => {
    it('чужая запись → 404', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(
        rowOf({ userId: otherUserId }),
      );
      await expect(svc.remove(userId, 'sf-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.savedFilter.delete).not.toHaveBeenCalled();
    });

    it('несуществующая запись → 404', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(null);
      await expect(svc.remove(userId, 'sf-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('успех → { deleted: true }', async () => {
      prisma.savedFilter.findUnique.mockResolvedValue(rowOf());
      prisma.savedFilter.delete.mockResolvedValue({});
      const r = await svc.remove(userId, 'sf-1');
      expect(prisma.savedFilter.delete).toHaveBeenCalledWith({
        where: { id: 'sf-1' },
      });
      expect(r).toEqual({ deleted: true });
    });
  });

  describe('toSavedFilterDto', () => {
    it('подмешивает section в params на чтении', () => {
      const dto = toSavedFilterDto(
        rowOf({
          section: 'workshop',
          params: { category: 'opening', tags: [] },
        }) as never,
      );
      expect(dto.params).toMatchObject({
        section: 'workshop',
        category: 'opening',
        tags: [],
      });
    });

    it('params=null/нестандартный → пустой объект с section', () => {
      const dto = toSavedFilterDto(
        rowOf({ section: 'archive', params: null }) as never,
      );
      expect(dto.params).toEqual({ section: 'archive' });
    });
  });
});
