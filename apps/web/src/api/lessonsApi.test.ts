import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { lessonsApi } from './lessonsApi';
import { api } from '../api';

/**
 * KS-2102: API больше НЕ принимает `?lang=`. Backend (KS-2101) читает
 * `User.locale`.
 *
 * KS-4143: после открытия каталога гостям (KS-4140) backend остался без
 * локального источника языка — у гостей нет `User.locale`. Frontend
 * теперь явно добавляет `?locale=<ru|en>` к каждому lessons GET. Для
 * авторизованных параметр безвреден (User.locale всё ещё в приоритете).
 *
 * Тесты проверяют, что lessonsApi:
 *   • НЕ добавляет query-параметр `lang` (легаси-имя из KS-2099);
 *   • добавляет `?locale=en|ru` (актуальный контракт KS-4143);
 *   • кодирует slug через encodeURIComponent.
 *
 * В тестовой среде i18n.language не инициализирован, `currentLocale()`
 * возвращает дефолт `en`.
 */

describe('lessonsApi: запросы курсов с ?locale= (KS-4143)', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSpy = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ data: [], items: [] } as never);
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  it('listCourses() → /lessons/courses?locale=en', async () => {
    await lessonsApi.listCourses();
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses?locale=en');
  });

  it('listActiveCourses() → /lessons/active-courses (без query)', async () => {
    await lessonsApi.listActiveCourses();
    expect(getSpy).toHaveBeenCalledWith('/lessons/active-courses');
  });

  it('getCourse(slug) → /lessons/courses/<slug>?locale=en', async () => {
    await lessonsApi.getCourse('capablanca-fundamentals');
    expect(getSpy).toHaveBeenCalledWith(
      '/lessons/courses/capablanca-fundamentals?locale=en',
    );
  });

  it('getCourse слаг с пробелами/спецсимволами → encodeURIComponent + ?locale=en', async () => {
    await lessonsApi.getCourse('a b/c');
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses/a%20b%2Fc?locale=en');
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
