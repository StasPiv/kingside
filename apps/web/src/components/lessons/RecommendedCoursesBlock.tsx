import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CourseLevel, CourseListItem } from '@kingside/shared';

import { lessonsApi } from '../../api/lessonsApi';
import { resolveInlineText } from '../../utils/inlineI18nText';
import { CourseCard, type CourseCardCtaVariant } from './CourseCard';

/**
 * `RecommendedCoursesBlock` — блок «Рекомендуем вам» на главной
 * /lessons (KS-1944 / KS-1931 §3).
 *
 * Берёт `recommendedLevel` из `lessonsApi.listCourses()` (поле
 * вычисляет бэк по `ratingPuzzle` пользователя), фильтрует курсы
 * по этому уровню, сортирует по `order` ASC и рендерит первые
 * 1–2 как `<CourseCard>`. Если `recommendedLevel == null` — блок
 * не рендерится вовсе (возвращает `null`).
 *
 * # Lazy-mount
 *
 * Сам блок не пересекается с IntersectionObserver — это делает
 * родитель через `<LazySection>` (см. `LessonsPage`). Поэтому
 * fetch внутри `useEffect` запускается только когда блок реально
 * смонтирован, и не нагружает первый paint страницы.
 *
 * # CTA маппинг
 *
 * Согласно §4 концепта, CTA в карточке зависит от состояния
 * прогресса пользователя по конкретному курсу:
 * - есть активный прогресс → `continue` (явный возврат к учёбе);
 * - курс пройден → `preview` (можно открыть «посмотреть»);
 * - прогресса нет → `preview` — для блока «Рекомендуем» это
 *   ознакомительный CTA «Посмотреть», а не «Начать» (KS-1942 спека:
 *   `preview` — «для рекомендаций»). Если хочется именно начать —
 *   это уже сделает CourseCard, открыв страницу курса.
 *
 * # Failure mode
 *
 * Если запрос упал или не вернул `recommendedLevel` — блок
 * молча скрывается. Это «nice to have» секция, не должна ломать
 * страницу.
 */

const MAX_RECOMMENDED = 2;

interface RecommendedState {
  loading: boolean;
  level: CourseLevel | null;
  courses: CourseListItem[];
}

function ctaForRecommended(course: CourseListItem): CourseCardCtaVariant {
  if (course.progress && !course.progress.completedAt) return 'continue';
  if (course.progress?.completedAt) return 'preview';
  return 'preview';
}

export function RecommendedCoursesBlock() {
  const { t } = useTranslation();
  const [state, setState] = useState<RecommendedState>({
    loading: true,
    level: null,
    courses: [],
  });

  useEffect(() => {
    let cancelled = false;
    lessonsApi
      .listCourses()
      .then((res) => {
        if (cancelled) return;
        const level = res.recommendedLevel ?? null;
        if (!level) {
          setState({ loading: false, level: null, courses: [] });
          return;
        }
        const courses = (res.data ?? [])
          .filter((c) => c.level === level)
          .sort((a, b) => a.order - b.order)
          .slice(0, MAX_RECOMMENDED);
        setState({ loading: false, level, courses });
      })
      .catch(() => {
        if (cancelled) return;
        // Тихо скрываемся: блок «рекомендаций» не должен ломать страницу.
        setState({ loading: false, level: null, courses: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return (
      <section
        className="recommended-courses-block recommended-courses-block--loading"
        data-testid="recommended-courses-block"
        data-state="loading"
        aria-busy="true"
      >
        <div className="recommended-courses-block__skeleton-title" />
        <div className="recommended-courses-block__skeleton-row" />
      </section>
    );
  }

  if (!state.level || state.courses.length === 0) {
    // Скрыт: рекомендация отсутствует или после фильтра нет курсов.
    return null;
  }

  return (
    <section
      className="recommended-courses-block"
      data-testid="recommended-courses-block"
      data-state="ready"
      data-level={state.level}
    >
      <header className="recommended-courses-block__header">
        <h2 className="recommended-courses-block__title">
          {t('lessons.recommended.title', 'Recommended for you')}
        </h2>
        <p className="recommended-courses-block__subtitle">
          {t(`lessons.recommended.subtitle.${state.level}`, {
            level: t(`lessons.level.${state.level}`),
            defaultValue: 'Curated for your level: {{level}}',
          })}
        </p>
      </header>
      <ul className="recommended-courses-block__list">
        {state.courses.map((course) => {
          // KS-1978: inline > i18nKey.
          const audience =
            resolveInlineText(course.audience, course.audienceI18nKey, t, '') ||
            null;
          const title = resolveInlineText(
            course.title,
            course.titleI18nKey,
            t,
            course.slug,
          );
          const progress = course.progress
            ? {
                done: course.progress.lessonsCompleted,
                total: course.lessonCount,
              }
            : null;
          return (
            <li
              key={course.id}
              className="recommended-courses-block__item"
            >
              <CourseCard
                slug={course.slug}
                href={`/lessons/${course.slug}`}
                title={title}
                level={course.level}
                difficulty={course.difficulty ?? null}
                estimatedMinutes={course.estimatedMinutes ?? null}
                coverUrl={course.coverUrl ?? null}
                audience={audience}
                progress={progress}
                ctaVariant={ctaForRecommended(course)}
                tags={course.tags ?? null}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
