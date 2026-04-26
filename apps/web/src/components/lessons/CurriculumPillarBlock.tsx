import { useTranslation } from 'react-i18next';
import type { CourseLevel, CourseListItem } from '@kingside/shared';

import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import { resolveInlineText } from '../../utils/inlineI18nText';
import { CourseCard, type CourseCardCtaVariant } from './CourseCard';

/**
 * `CurriculumPillarBlock` — обёртка над системными уровневыми
 * курсами (KS-1923, ADR-031 §2): отдельный pillar L3
 * «Структурированный курс шахмат», визуально выделенный из
 * пользовательского контента.
 *
 * Принимает уже отфильтрованные/сгруппированные `groups` из
 * родителя (`LessonsPage`), чтобы не делать второй запрос.
 * Логика fetch'а / recommendedLevel — на стороне `LessonsPage`,
 * как было до KS-1923.
 *
 * Anchor `id="level-{level}"` — для якорной навигации из
 * `LessonsHero` (CTA «Browse Beginner curriculum»).
 */

export interface CurriculumGroup {
  level: CourseLevel;
  items: CourseListItem[];
}

interface CurriculumPillarBlockProps {
  groups: CurriculumGroup[];
  recommendedLevel?: CourseLevel | null;
  loading: boolean;
  error: string | null;
  emptyText: string;
}

/**
 * Решение по CTA для системных курсов на основе прогресса:
 *  - `null`/нет записи → ещё не начат → `start`.
 *  - `completedAt != null` → пройден → `preview` (можно повторить).
 *  - иначе → активный → `continue`.
 */
function ctaForCourse(course: CourseListItem): CourseCardCtaVariant {
  if (!course.progress) return 'start';
  if (course.progress.completedAt) return 'preview';
  return 'continue';
}

export function CurriculumPillarBlock({
  groups,
  recommendedLevel,
  loading,
  error,
  emptyText,
}: CurriculumPillarBlockProps) {
  const { t } = useTranslation();
  // KS-1924: анти-flicker. Skeleton рисуем только если loading >200мс.
  // На быстром API сразу пропускаем сразу к `ready`.
  const showSkeleton = useDelayedFlag(loading, 200);

  if (loading) {
    if (!showSkeleton) {
      // Маленький «пустой» плейсхолдер, чтобы не создавать layout-shift,
      // когда данные ещё в полёте (<200мс): тот же data-state="loading",
      // но без визуального skeleton'а.
      return (
        <section
          className="curriculum-pillar-block curriculum-pillar-block--loading"
          data-testid="curriculum-pillar-block"
          data-state="loading"
          aria-busy="true"
        />
      );
    }
    return (
      <section
        className="curriculum-pillar-block curriculum-pillar-block--loading"
        data-testid="curriculum-pillar-block"
        data-state="loading"
        aria-busy="true"
      >
        <div className="curriculum-pillar-block__skeleton-title" />
        <div className="curriculum-pillar-block__skeleton-row" />
        <div className="curriculum-pillar-block__skeleton-row" />
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="curriculum-pillar-block"
        data-testid="curriculum-pillar-block"
        data-state="error"
      >
        <div className="error" data-testid="lessons-error">
          {error}
        </div>
      </section>
    );
  }

  if (groups.length === 0) {
    return (
      <section
        className="curriculum-pillar-block"
        data-testid="curriculum-pillar-block"
        data-state="empty"
      >
        <div className="lessons-empty" data-testid="lessons-empty">
          {emptyText}
        </div>
      </section>
    );
  }

  return (
    <section
      className="curriculum-pillar-block"
      data-testid="curriculum-pillar-block"
      data-state="ready"
    >
      <header className="curriculum-pillar-block__header">
        <h2 className="curriculum-pillar-block__title">
          {t('lessons.curriculum.title', 'Structured chess curriculum')}
        </h2>
        <p className="curriculum-pillar-block__subtitle">
          {t(
            'lessons.curriculum.subtitle',
            'Beginner → Intermediate → Advanced. Curated by the Kingside team.',
          )}
        </p>
      </header>

      {groups.map(({ level, items }) => (
        <section
          key={level}
          id={`level-${level}`}
          className="lessons-level-section"
          data-testid={`lessons-level-${level}`}
        >
          <h3 className="lessons-level-title">
            {t(`lessons.level.${level}`)}
            {recommendedLevel === level && (
              <span
                className="lessons-recommended-badge"
                data-testid="lessons-recommended-badge"
              >
                {t('lessons.recommendedForYou', 'Recommended for you')}
              </span>
            )}
          </h3>
          <ul className="lessons-course-grid">
            {items.map((course) => {
              // KS-1978: inline > i18nKey. Для audience пустая итоговая
              // строка → null, чтобы CourseCard скрыл слот.
              const audience =
                resolveInlineText(course.audience, course.audienceI18nKey, t, '') ||
                null;
              const title = resolveInlineText(
                course.title,
                course.titleI18nKey,
                t,
                course.slug,
              );
              const progress =
                course.progress
                  ? {
                      done: course.progress.lessonsCompleted,
                      total: course.lessonCount,
                    }
                  : null;
              return (
                <li key={course.id} className="lessons-course-card-item">
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
                    ctaVariant={ctaForCourse(course)}
                    tags={course.tags ?? null}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
