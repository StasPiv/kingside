import type {
  UserCourseDto,
  UserLessonDto,
} from '@kingside/shared';

/**
 * Pure-функции, используемые `UserCourseEditor` (KS-1857 / FE-R9).
 * Выделены из компонента, чтобы покрыть логикой unit-тестами без
 * рендера (render-тест корня уходит в OOM vitest-worker'а — см. отчёт
 * KS-1857).
 *
 * Каждая функция — детерминистичная, без сайд-эффектов.
 */

// ─── Owner-guard ──────────────────────────────────────────────────────

/**
 * Решает, должен ли текущий пользователь быть допущен в редактор:
 *   - `null` — guard прошёл, показываем редактор
 *   - `'unauthorized'` — нет токена/юзера, редирект на /login
 *   - `'forbidden'` — чужой курс или 4xx при загрузке
 *
 * Применение в UserCourseEditor:
 *   ```ts
 *   const verdict = resolveOwnerGuard({
 *     userId: user?.id ?? null,
 *     course,
 *     loadError,
 *   });
 *   if (verdict === 'unauthorized') return <Navigate to="/login" />;
 *   if (verdict === 'forbidden') return <Navigate to="/lessons" />;
 *   ```
 */
export function resolveOwnerGuard(input: {
  userId: string | null;
  course: UserCourseDto | null;
  /** true если `getBySlug` упал с 4xx/сетью. */
  loadError: boolean;
}): 'unauthorized' | 'forbidden' | null {
  if (input.userId === null) return 'unauthorized';
  if (input.loadError) return 'forbidden';
  if (!input.course) return null; // всё ещё loading
  if (input.course.ownerId !== input.userId) return 'forbidden';
  return null;
}

// ─── Active lesson resolution из URL ──────────────────────────────────

/**
 * Определяет активный урок по query-параметру и списку уроков:
 *   - если `?lesson=:id` задан И такой id есть среди lessons — вернуть его
 *   - иначе — первый урок по `order`
 *   - если lessons пуст — null
 */
export function resolveActiveLessonId(input: {
  lessonsQuery: string | null;
  lessons: readonly UserLessonDto[];
}): string | null {
  if (input.lessons.length === 0) return null;
  const fromQuery = input.lessonsQuery;
  if (fromQuery && input.lessons.some((l) => l.id === fromQuery)) {
    return fromQuery;
  }
  // lessons внутри `useUserCourseState` уже отсортированы по `order`
  // (см. reducer loadCourse/reorderLessons). Возвращаем первый.
  return input.lessons[0]?.id ?? null;
}

// ─── Next-active при удалении ─────────────────────────────────────────

/**
 * Когда удаляем урок — кого сделать активным дальше. Берём соседа по
 * индексу: если удалили первого, активен следующий; если последний,
 * активен предыдущий. Если после удаления уроков не осталось — null.
 */
export function pickNextActiveLessonId(
  lessons: readonly UserLessonDto[],
  deletedId: string,
): string | null {
  const idx = lessons.findIndex((l) => l.id === deletedId);
  if (idx === -1) {
    // Удалённого урока нет в списке — вернуть первого оставшегося, если есть
    return lessons[0]?.id ?? null;
  }
  const remaining = lessons.filter((l) => l.id !== deletedId);
  if (remaining.length === 0) return null;
  // Индекс в remaining: если удаляемый был первым (idx=0) — показываем
  // того, кто был вторым (теперь на remaining[0]); если был не первым —
  // показываем предыдущего (remaining[idx-1]).
  if (idx === 0) return remaining[0].id;
  return remaining[idx - 1].id;
}

// ─── Reorder ──────────────────────────────────────────────────────────

/**
 * Меняет местами два элемента массива id'ов по индексам. Возвращает
 * новый массив; если индекс за пределами — возвращает копию без
 * изменений. Используется в `moveLesson` / `moveStep` для атомарной
 * перестановки.
 */
export function swapAt<T>(arr: readonly T[], i: number, j: number): T[] {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length || i === j) {
    return arr.slice();
  }
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ─── Build public course URL (для Copy-link) ─────────────────────────

/**
 * Собирает публичный URL курса: `<origin>/lessons/my/:slug`. Принимает
 * origin отдельно, чтобы не зависеть от `window` и быть тестируемой.
 */
export function buildPublicCourseUrl(origin: string, slug: string): string {
  const trimmed = origin.replace(/\/+$/, '');
  return `${trimmed}/lessons/my/${slug}`;
}
