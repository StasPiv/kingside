import { useEffect, useMemo, useState } from 'react';
import type {
  CourseLevel,
  CourseListItem,
  UserCourseDto,
  UserEnrolledCourseDto,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { userCoursesApi } from '../api/userCoursesApi';
import { useAuth } from '../context/AuthContext';

/**
 * `useLessonsHeroContext` — агрегирует данные для контекстного hero
 * на `/lessons` (KS-1922 / KS-1938 / KS-1931 §3.2 §4).
 *
 * Решает какой hero-вариант показать. Приоритет:
 *  1. **`guest`** — `user === null` (P3, концепт §3.2).
 *  2. **`loading`** — auth и/или fetch'ы не отдали (skeleton).
 *  3. **`multi`** — у пользователя ≥2 активных курсов (variant C
 *     в §3.2). Активный = `progress != null && completedAt == null`,
 *     суммарно по системным курсам (`lessonsApi.listCourses`) и
 *     enrolled-пользовательским (`userCoursesApi.listEnrolled`).
 *  4. **`continue`** — ровно 1 активный курс (variant B). Берём этот
 *     единственный, нормализуем shape для UI.
 *  5. **`author`** — нет активных, есть свои `own` курсы (P4).
 *  6. **`start`** — нет активных и нет своих (variant A). Кладём
 *     `beginnerSlug` системного beginner-курса для CTA «Открыть
 *     курс для начинающих».
 *
 * KS-1938 переставляет `multi`/`continue` ВЫШЕ `author` относительно
 * предыдущей реализации: автор с активным прогрессом теперь видит
 * прогресс, а не «карточка автора + Open editor». Это согласовано
 * концептом §3.2 («A/B/C — внутри ветки аутентифицирован, не автор
 * без активности»).
 *
 * KS-1938: «custom» (свои курсы автора) для подсчёта активности
 * НЕ учитываются — у `UserCourseDto` нет `progress`. Если автор
 * enroll'нулся в свой курс, прогресс возвращается через
 * `listEnrolled` на общих основаниях (концепт §3.3).
 *
 * Реализация — три параллельных fetch'а на mount, `useMemo` для
 * derived selection. Гости вообще не fetch'ят (P3 сразу).
 */

export type ActiveCourseSource = 'system' | 'enrolled';

/**
 * Унифицированная shape «активного курса» для variant B (`continue`).
 * Системные курсы и enrolled-пользовательские имеют разные DTO; для
 * рендера hero нужны одни и те же поля. Маппинг в `mapToActive*`
 * ниже фиксирует, откуда что берём.
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
   * ISO-8601, для сортировки «самый свежий». У enrolled —
   * `progress.lastActivityAt` (есть в `UserCoursePlayProgressDto`). У
   * `system` поле `lastActivityAt` отсутствует — fallback на
   * `progress.startedAt`.
   */
  lastActivityAt: string;
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
      /** i18n-ключ заголовка beginner-курса для подзаголовка. null если нет. */
      beginnerTitleI18nKey: string | null;
    }
  | { kind: 'guest' };

interface UseLessonsHeroContextReturn {
  state: LessonsHeroState;
}

function mapSystemToActive(c: CourseListItem): ActiveCourseSummary | null {
  if (!c.progress || c.progress.completedAt !== null) return null;
  return {
    source: 'system',
    id: c.id,
    slug: c.slug,
    title: '',
    titleI18nKey: c.titleI18nKey,
    level: c.level,
    coverUrl: c.coverUrl ?? null,
    lessonCount: c.lessonCount,
    completedLessons: c.progress.lessonsCompleted,
    lastActivityAt: c.progress.startedAt,
    href: `/lessons/${c.slug}`,
  };
}

function mapEnrolledToActive(
  c: UserEnrolledCourseDto,
): ActiveCourseSummary | null {
  if (c.progress.completedAt !== null) return null;
  return {
    source: 'enrolled',
    id: c.id,
    slug: c.slug,
    title: c.title,
    titleI18nKey: null,
    level: null,
    coverUrl: c.coverUrl ?? null,
    lessonCount: c.lessonCount,
    completedLessons: c.progress.completedLessonsCount,
    lastActivityAt: c.progress.lastActivityAt,
    href: `/lessons/my/${c.slug}`,
  };
}

export function useLessonsHeroContext(): UseLessonsHeroContextReturn {
  const { user, loading: authLoading } = useAuth();

  const [system, setSystem] = useState<CourseListItem[] | null>(null);
  const [systemErrored, setSystemErrored] = useState(false);
  const [enrolled, setEnrolled] = useState<UserEnrolledCourseDto[] | null>(
    null,
  );
  const [enrolledErrored, setEnrolledErrored] = useState(false);
  const [own, setOwn] = useState<UserCourseDto[] | null>(null);
  const [ownErrored, setOwnErrored] = useState(false);

  useEffect(() => {
    if (!user) {
      setSystem(null);
      setEnrolled(null);
      setOwn(null);
      setSystemErrored(false);
      setEnrolledErrored(false);
      setOwnErrored(false);
      return;
    }
    let cancelled = false;
    setSystemErrored(false);
    setEnrolledErrored(false);
    setOwnErrored(false);
    setSystem(null);
    setEnrolled(null);
    setOwn(null);

    lessonsApi
      .listCourses()
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
      .listEnrolled()
      .then((res) => {
        if (cancelled) return;
        setEnrolled(res.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setEnrolledErrored(true);
        setEnrolled([]);
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
  }, [user]);

  const state = useMemo<LessonsHeroState>(() => {
    if (authLoading) return { kind: 'loading' };
    if (!user) return { kind: 'guest' };

    // Ждём все три fetch'а (или их ошибки). Errored = пустой массив
    // — деградирует мягко, hero подберёт следующий приоритет.
    if (system === null || enrolled === null || own === null) {
      return { kind: 'loading' };
    }

    // Активные курсы (система + enrolled). Custom (own) для активности
    // не считаем — у `UserCourseDto` нет `progress`.
    const activeSystem = system
      .map(mapSystemToActive)
      .filter((c): c is ActiveCourseSummary => c !== null);
    const activeEnrolled = enrolled
      .map(mapEnrolledToActive)
      .filter((c): c is ActiveCourseSummary => c !== null);
    const allActive = [...activeSystem, ...activeEnrolled].sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );

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
      beginnerTitleI18nKey: beginner?.titleI18nKey ?? null,
    };
  }, [authLoading, user, system, enrolled, own]);

  // *Errored — внутренние, наружу не отдаём (свёрнуты в пустые массивы).
  void systemErrored;
  void enrolledErrored;
  void ownErrored;

  return { state };
}
