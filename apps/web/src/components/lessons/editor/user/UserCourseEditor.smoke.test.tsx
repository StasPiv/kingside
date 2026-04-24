import { describe, it, expect } from 'vitest';

/**
 * KS-1857 (FE-R9): минимальный smoke-тест на модуль.
 *
 * Полноценное рендер-тестирование `<UserCourseEditor>` с моками
 * `useSearchParams`, `userCoursesApi` и всех дочерних компонентов
 * показало, что jsdom worker уходит в OOM при импорте (причина —
 * пересечение react-router v7 `useSearchParams` + reducer-рендеров
 * `useUserCourseState` + vi.mock hoisting). Пока это не разобрано,
 * smoke-тест ограничивается:
 *  1. Успешная загрузка модуля (импорт не бросает).
 *  2. Экспорт `UserCourseEditor` — функция-компонент.
 *
 * Full-intergation e2e (Playwright) покроет рабочий сценарий в
 * отдельном тикете. Все подкомпоненты (Header/Outline/StepCard/
 * LessonOverview/*Fields) покрыты своими юнит-тестами.
 */

describe('UserCourseEditor module', () => {
  it('импортируется без ошибок и экспортирует компонент', async () => {
    const mod = await import('./UserCourseEditor');
    expect(typeof mod.UserCourseEditor).toBe('function');
  });
});
