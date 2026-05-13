/**
 * KS-2929 Phase A5. Тесты legacy-mapper: эквивалентность плоского
 * и канонического формата saved_filters.
 */
import {
  legacyCreateToShared,
  legacyUpdateToShared,
  toLegacyShape,
} from './saved-filter-legacy.mapper';
import type { SavedFilterDto } from '@kingside/shared';

function workshopDto(
  overrides: Partial<{
    name: string;
    category: string | null;
    tags: string[];
    search: string | null;
    sortOrder: string | null;
  }> = {},
): SavedFilterDto {
  return {
    id: 'sf-1',
    section: 'workshop',
    name: overrides.name ?? 'Spanish',
    params: {
      section: 'workshop',
      category: overrides.category ?? null,
      tags: overrides.tags ?? [],
      search: overrides.search ?? null,
      sortOrder: overrides.sortOrder ?? null,
    },
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:30:00.000Z',
  };
}

describe('saved-filter-legacy.mapper — KS-2929', () => {
  describe('toLegacyShape', () => {
    it('пустой workshop-фильтр → все плоские поля null/null', () => {
      const r = toLegacyShape('user-1', workshopDto());
      expect(r).toEqual({
        id: 'sf-1',
        userId: 'user-1',
        name: 'Spanish',
        category: null,
        tags: null,
        search: null,
        sortOrder: null,
        createdAt: '2026-05-13T08:00:00.000Z',
      });
    });

    it('tags[] сериализуется в CSV; пустой массив → null', () => {
      expect(
        toLegacyShape('u', workshopDto({ tags: ['italian', 'spanish'] }))
          .tags,
      ).toBe('italian,spanish');
      expect(toLegacyShape('u', workshopDto({ tags: [] })).tags).toBeNull();
    });

    it('плоские поля транзитом, пустые строки трактуем как null', () => {
      const r = toLegacyShape(
        'u',
        workshopDto({ category: 'opening', search: 'e4', sortOrder: 'newest' }),
      );
      expect(r.category).toBe('opening');
      expect(r.search).toBe('e4');
      expect(r.sortOrder).toBe('newest');
    });

    it('archive-секция в legacy-эндпоинте → ошибка', () => {
      const archive: SavedFilterDto = {
        id: 'a',
        section: 'archive',
        name: 'A',
        params: {
          section: 'archive',
          players: [],
          event: null,
          eco: null,
          result: null,
          minElo: null,
          since: null,
          until: null,
          minPly: null,
          maxPly: null,
          timeControlCategory: [],
          sort: null,
        },
        createdAt: '',
        updatedAt: '',
      };
      expect(() => toLegacyShape('u', archive)).toThrow(
        /section=archive/,
      );
    });
  });

  describe('legacyCreateToShared', () => {
    it('минимум: только name → params со всеми null/[]', () => {
      const r = legacyCreateToShared({ name: 'X' } as never);
      expect(r).toEqual({
        section: 'workshop',
        name: 'X',
        params: {
          section: 'workshop',
          category: null,
          tags: [],
          search: null,
          sortOrder: null,
        },
      });
    });

    it('CSV tags парсится в string[]; пустые элементы отбрасываются', () => {
      const r = legacyCreateToShared({
        name: 'X',
        category: '',
        tags: 'a,,b,c',
        search: '',
        sortOrder: '',
      } as never);
      expect(r.params).toEqual({
        section: 'workshop',
        category: null,
        tags: ['a', 'b', 'c'],
        search: null,
        sortOrder: null,
      });
    });

    it('непустые значения → транзитом', () => {
      const r = legacyCreateToShared({
        name: 'X',
        category: 'opening',
        tags: 'italian',
        search: 'e4',
        sortOrder: 'newest',
      } as never);
      expect(r.params).toEqual({
        section: 'workshop',
        category: 'opening',
        tags: ['italian'],
        search: 'e4',
        sortOrder: 'newest',
      });
    });
  });

  describe('legacyUpdateToShared', () => {
    it('только name → params не отправляем', () => {
      const r = legacyUpdateToShared({ name: 'New' } as never);
      expect(r).toEqual({ name: 'New' });
      expect((r as { params?: unknown }).params).toBeUndefined();
    });

    it('любое плоское поле задано → собираем полный params', () => {
      const r = legacyUpdateToShared({ category: 'opening' } as never);
      expect(r.name).toBeUndefined();
      expect(r.params).toEqual({
        section: 'workshop',
        category: 'opening',
        tags: [],
        search: null,
        sortOrder: null,
      });
    });

    it('name + полный plain patch', () => {
      const r = legacyUpdateToShared({
        name: 'New',
        category: 'middlegame',
        tags: 'kingside,attack',
        search: 'Bxh7',
        sortOrder: 'oldest',
      } as never);
      expect(r).toEqual({
        name: 'New',
        params: {
          section: 'workshop',
          category: 'middlegame',
          tags: ['kingside', 'attack'],
          search: 'Bxh7',
          sortOrder: 'oldest',
        },
      });
    });

    it('пустой dto → пустой результат (нечего обновлять)', () => {
      expect(legacyUpdateToShared({} as never)).toEqual({});
    });
  });
});
