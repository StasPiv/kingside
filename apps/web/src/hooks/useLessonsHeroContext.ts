import { useEffect, useMemo, useState } from 'react';
import type {
  UserCourseDto,
  UserEnrolledCourseDto,
} from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';
import { useAuth } from '../context/AuthContext';

/**
 * `useLessonsHeroContext` — агрегирует данные для контекстного hero
 * на `/lessons` (KS-1922 / ADR-031 §4.1).
 *
 * Решает какой из 5 hero-вариантов показать. Приоритет:
 *  1. **P1 «Continue learning»** — есть незавершённый enrolled-курс
 *     (`progress.completedAt == null`), берём с самым свежим
 *     `lastActivityAt`. Returning студент важнее всего остального.
 *  2. **P4 «Author summary»** — есть свой курс. Берём последний по
 *     `updatedAt` для CTA «Открыть редактор».
 *  3. **P2 «Start with Beginner»** — авторизован, нет ни enrolled,
 *     ни своих → новичок, направляем в системный Beginner-курс.
 *  4. **P3 «Guest»** — `user === null`.
 *  5. **Loading** — пока fetch'ы не отдали → skeleton.
 *
 * Реализация — два параллельных fetch (enrolled + own) на mount,
 * `useMemo` для derived selection. Гости вообще не fetch'ят
 * (P3 сразу).
 */

export type LessonsHeroState =
  | { kind: 'loading' }
  | {
      kind: 'continue';
      course: UserEnrolledCourseDto;
    }
  | {
      kind: 'author';
      ownedCount: number;
      publicCount: number;
      privateCount: number;
      latestCourse: UserCourseDto | null;
    }
  | { kind: 'start' }
  | { kind: 'guest' };

interface UseLessonsHeroContextReturn {
  state: LessonsHeroState;
}

export function useLessonsHeroContext(): UseLessonsHeroContextReturn {
  const { user, loading: authLoading } = useAuth();

  const [enrolled, setEnrolled] = useState<UserEnrolledCourseDto[] | null>(
    null,
  );
  const [enrolledErrored, setEnrolledErrored] = useState(false);
  const [own, setOwn] = useState<UserCourseDto[] | null>(null);
  const [ownErrored, setOwnErrored] = useState(false);

  useEffect(() => {
    if (!user) {
      setEnrolled(null);
      setOwn(null);
      setEnrolledErrored(false);
      setOwnErrored(false);
      return;
    }
    let cancelled = false;
    setEnrolledErrored(false);
    setOwnErrored(false);
    setEnrolled(null);
    setOwn(null);

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

    // Ждём оба fetch (или их ошибки) — иначе можно увидеть P2
    // «новичок» при ещё не подгруженных курсах. Errored = пустой
    // массив (см. catch выше) — это эквивалентно «нет данных».
    if (enrolled === null || own === null) return { kind: 'loading' };

    // P1: незавершённый enrolled курс с самым свежим lastActivityAt.
    const inProgress = enrolled
      .filter((c) => c.progress && !c.progress.completedAt)
      .sort((a, b) => {
        const ta = new Date(a.progress.lastActivityAt).getTime();
        const tb = new Date(b.progress.lastActivityAt).getTime();
        return tb - ta;
      });
    if (inProgress.length > 0) {
      return { kind: 'continue', course: inProgress[0] };
    }

    // P4: автор хотя бы одного курса.
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

    // P2: авторизован, нет ни enrolled, ни своих → новичок.
    return { kind: 'start' };
  }, [authLoading, user, enrolled, own]);

  // enrolledErrored / ownErrored используются внутри для свёртывания
  // в пустые массивы — наружу их не возвращаем, hero корректно
  // деградирует в P2/P4 в зависимости от того что удалось загрузить.
  void enrolledErrored;
  void ownErrored;

  return { state };
}
