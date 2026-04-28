import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ActiveCourseDto,
  CourseLevel,
  CourseListItem,
  UserCourseDto,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { userCoursesApi } from '../api/userCoursesApi';
import { useAuth } from '../context/AuthContext';
import { mapActiveCourses } from '../utils/activeCourseSummary';

/**
 * `useLessonsHeroContext` — агрегирует данные для контекстного hero
 * на `/lessons` (KS-1922 → KS-1938 → KS-1957 / KS-1931 §3.2 §4).
 *
 * Решает какой hero-вариант показать. Приоритет:
 *  1. **`guest`** — `user === null` (P3, концепт §3.2).
 *  2. **`loading`** — auth и/или fetch'ы не отдали (skeleton).
 *  3. **`multi`** — у пользователя ≥2 активных курсов (variant C
 *     в §3.2).
 *  4. **`continue`** — ровно 1 активный курс (variant B). Берём этот
 *     единственный, нормализуем shape для UI.
 *  5. **`author`** — нет активных, есть свои `own` курсы (P4).
 *  6. **`start`** — нет активных и нет своих (variant A). Кладём
 *     `beginnerSlug` системного beginner-курса для CTA «Открыть
 *     курс для начинающих».
 *
 * KS-1957 (F-12): «активные» теперь приходят одним запросом
 * `lessonsApi.listActiveCourses` (агрегат system + enrolled на бэке,
 * фильтрация и сортировка по `lastActivityAt` DESC — там же).
 * Раньше было два запроса (`listCourses` + `listEnrolled`) с
 * клиентским merge, что давало лишний трафик и две точки отказа.
 *
 * `listCourses` фронту по-прежнему нужен — но только ради
 * `beginnerSlug` для variant `start`. Решено оставить параллельный
 * fetch (а не загружать ленниво по нужде) — это упрощает state-machine
 * и не дороже одного запроса.
 *
 * KS-1938: «custom» (свои курсы автора) для подсчёта активности
 * НЕ учитываются — у `UserCourseDto` нет `progress`. Если автор
 * enroll'нулся в свой курс, прогресс возвращается через
 * `/lessons/active-courses` как enrolled (концепт §3.3).
 */

export type ActiveCourseSource = 'system' | 'enrolled';

/**
 * Унифицированная shape «активного курса» для variant B (`continue`).
 * Маппинг в `utils/activeCourseSummary.mapActiveCourses` (KS-1957)
 * сужает дискриминированный union `ActiveCourseDto` (system/enrolled)
 * в общую shape, которую потребляют Hero и MyActiveCoursesPage.
 *
 * KS-1955 / KS-1957: поля `currentLessonSlug`, `currentLessonTitleI18nKey`
 * (system) / `currentLessonTitle` (enrolled), `currentLessonOrder` —
 * для подзаголовка «Урок N из M — название» в variant B.
 * `lastActivityAt` — для строки «Последняя активность: N дней назад»
 * и сортировки.
 */
export interface ActiveCourseSummary {
  source: ActiveCourseSource;
  id: string;
  slug: string;
  /** Заголовок для UI. Для `system` — пустая строка; компонент
   *  использует `titleI18nKey` через `t()`. Для `enrolled` — DTO `title`. */
  title: string;
  /** Только для `source='system'`. */
  titleI18nKey: string | null;
  /** Только для `source='system'` (у пользовательских курсов уровня нет). */
  level: CourseLevel | null;
  /** Обложка из `CourseCardFields` (есть и у `system`, и у `enrolled`). */
  coverUrl: string | null;
  lessonCount: number;
  completedLessons: number;
  /**
   * ISO-8601, для отображения «последняя активность» и сортировки.
   * Бэк отдаёт уже подсчитанный MAX в `/lessons/active-courses`.
   */
  lastActivityAt: string;
  /** Текущий незавершённый урок — для подзаголовка «Урок N из M». */
  currentLessonSlug: string | null;
  currentLessonTitleI18nKey: string | null;
  currentLessonTitle: string | null;
  currentLessonOrder: number | null;
  /** Куда вести CTA «Продолжить» (разные namespace'ы у двух источников). */
  href: string;
}

export type LessonsHeroState =
  | { kind: 'loading' }
  | { kind: 'continue'; course: ActiveCourseSummary }
  | { kind: 'multi'; count: number }
  | {
      kind: 'author';
      ownedCount: number;
      publicCount: number;
      privateCount: number;
      latestCourse: UserCourseDto | null;
    }
  | {
      kind: 'start';
      /** Slug первого beginner-курса (по `order`). null если беги-курсов нет. */
      beginnerSlug: string | null;
      /** Inline-заголовок beginner-курса (KS-1978). null если бэк не отдал. */
      beginnerTitle: string | null;
      /** i18n-ключ заголовка beginner-курса (fallback). null если нет. */
      beginnerTitleI18nKey: string | null;
    }
  | { kind: 'guest' };

interface UseLessonsHeroContextReturn {
  state: LessonsHeroState;
}

export function useLessonsHeroContext(): UseLessonsHeroContextReturn {
  const { user, loading: authLoading } = useAuth();
  // KS-2099: язык UI прокидываем в `listActiveCourses`/`listCourses`,
  // чтобы hero брал курсы той же локали, что и /lessons список.
  const { i18n } = useTranslation();
  const lang = i18n.language;

  // KS-1957: единый источник активности — `/lessons/active-courses`.
  const [active, setActive] = useState<ActiveCourseDto[] | null>(null);
  const [activeErrored, setActiveErrored] = useState(false);
  // listCourses нужен только ради beginnerSlug для variant `start`.
  const [system, setSystem] = useState<CourseListItem[] | null>(null);
  const [systemErrored, setSystemErrored] = useState(false);
  // own — для variant `author` (нет прогресса, но есть созданные курсы).
  const [own, setOwn] = useState<UserCourseDto[] | null>(null);
  const [ownErrored, setOwnErrored] = useState(false);

  useEffect(() => {
    if (!user) {
      setActive(null);
      setSystem(null);
      setOwn(null);
      setActiveErrored(false);
      setSystemErrored(false);
      setOwnErrored(false);
      return;
    }
    let cancelled = false;
    setActiveErrored(false);
    setSystemErrored(false);
    setOwnErrored(false);
    setActive(null);
    setSystem(null);
    setOwn(null);

    lessonsApi
      .listActiveCourses(lang)
      .then((res) => {
        if (cancelled) return;
        setActive(res ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveErrored(true);
        setActive([]);
      });

    lessonsApi
      .listCourses(lang)
      .then((res) => {
        if (cancelled) return;
        setSystem(res.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setSystemErrored(true);
        setSystem([]);
      });

    userCoursesApi
      .list({ scope: 'own' })
      .then((res) => {
        if (cancelled) return;
        setOwn(res.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setOwnErrored(true);
        setOwn([]);
      });

    return () => {
      cancelled = true;
    };
  }, [user, lang]);

  const state = useMemo<LessonsHeroState>(() => {
    if (authLoading) return { kind: 'loading' };
    if (!user) return { kind: 'guest' };

    // Ждём все три fetch'а (или их ошибки). Errored = пустой массив
    // — деградирует мягко, hero подберёт следующий приоритет.
    if (active === null || system === null || own === null) {
      return { kind: 'loading' };
    }

    const allActive = mapActiveCourses(active);

    if (allActive.length >= 2) {
      return { kind: 'multi', count: allActive.length };
    }
    if (allActive.length === 1) {
      return { kind: 'continue', course: allActive[0] };
    }

    // 0 активных. Дальше — author / start.
    if (own.length > 0) {
      const sorted = own
        .slice()
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() -
            new Date(a.updatedAt).getTime(),
        );
      const publicCount = own.filter((c) => c.isPublic).length;
      const privateCount = own.length - publicCount;
      return {
        kind: 'author',
        ownedCount: own.length,
        publicCount,
        privateCount,
        latestCourse: sorted[0] ?? null,
      };
    }

    // start: первый beginner-курс по `order` ASC.
    const beginner = system
      .filter((c) => c.level === 'beginner')
      .sort((a, b) => a.order - b.order)[0];
    return {
      kind: 'start',
      beginnerSlug: beginner?.slug ?? null,
      // KS-1978: inline title имеет приоритет; UI делает финальный
      // fallback через `resolveInlineText`.
      beginnerTitle: beginner?.title ?? null,
      beginnerTitleI18nKey: beginner?.titleI18nKey ?? null,
    };
  }, [authLoading, user, active, system, own]);

  // *Errored — внутренние, наружу не отдаём (свёрнуты в пустые массивы).
  void activeErrored;
  void systemErrored;
  void ownErrored;

  return { state };
}
