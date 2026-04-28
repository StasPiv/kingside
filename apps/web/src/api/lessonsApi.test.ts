import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { lessonsApi } from './lessonsApi';
import { api } from '../api';

/**
 * KS-2102: API больше НЕ принимает `?lang=`. Backend (KS-2101)
 * читает `User.locale`. Тесты проверяют, что lessonsApi:
 *   • НЕ добавляет query-параметр `lang`;
 *   • кодирует slug через encodeURIComponent.
 *
 * Покрытие смены языка перенесено в MainLayout-тест (PATCH
 * /users/me/settings + invalidation на следующих effect-ах).
 */

describe('lessonsApi: запросы курсов без ?lang= (KS-2102)', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSpy = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ data: [], items: [] } as never);
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  it('listCourses() → /lessons/courses (без query)', async () => {
    await lessonsApi.listCourses();
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses');
  });

  it('listActiveCourses() → /lessons/active-courses (без query)', async () => {
    await lessonsApi.listActiveCourses();
    expect(getSpy).toHaveBeenCalledWith('/lessons/active-courses');
  });

  it('getCourse(slug) → /lessons/courses/<slug> (без query)', async () => {
    await lessonsApi.getCourse('capablanca-fundamentals');
    expect(getSpy).toHaveBeenCalledWith(
      '/lessons/courses/capablanca-fundamentals',
    );
  });

  it('getCourse слаг с пробелами/спецсимволами → encodeURIComponent', async () => {
    await lessonsApi.getCourse('a b/c');
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses/a%20b%2Fc');
  });

  it('ни один из вызовов не подставляет ?lang= (регрессия KS-2099 → KS-2102)', async () => {
    await lessonsApi.listCourses();
    await lessonsApi.listActiveCourses();
    await lessonsApi.getCourse('foo');
    for (const call of getSpy.mock.calls) {
      const url = call[0] as string;
      expect(url).not.toMatch(/[?&]lang=/);
    }
  });
});
