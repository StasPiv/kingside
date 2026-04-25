import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseLevel, CourseListItem } from '@kingside/shared';

/**
 * `CurriculumPillarBlock` — обёртка над системными уровневыми
 * курсами (KS-1923, ADR-031 §2): отдельный pillar L3
 * «Структурированный курс шахмат», визуально выделенный из
 * пользовательского контента.
 *
 * Принимает уже отфильтрованные/сгруппированные `groups` из
 * родителя (`LessonsPage`), чтобы не делать второй запрос.
 * Логика fetch'а / level-gate / recommendedLevel — на стороне
 * `LessonsPage`, как было до KS-1923.
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

export function CurriculumPillarBlock({
  groups,
  recommendedLevel,
  loading,
  error,
  emptyText,
}: CurriculumPillarBlockProps) {
  const { t } = useTranslation();

  if (loading) {
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
            {items.map((course) => (
              <li key={course.id} className="lessons-course-card">
                <Link
                  to={`/lessons/${course.slug}`}
                  className="lessons-course-link"
                  data-testid={`course-link-${course.slug}`}
                >
                  <h4 className="lessons-course-title">
                    {t(course.titleI18nKey, course.slug)}
                  </h4>
                  <p className="lessons-course-description">
                    {t(course.descriptionI18nKey, '')}
                  </p>
                  <div className="lessons-course-meta">
                    <span>
                      {t('lessons.lessonCount', {
                        count: course.lessonCount,
                        defaultValue: '{{count}} lessons',
                      })}
                    </span>
                    {course.progress && (
                      <span className="lessons-course-progress">
                        {t('lessons.progressShort', {
                          completed: course.progress.lessonsCompleted,
                          total: course.lessonCount,
                          defaultValue: '{{completed}}/{{total}}',
                        })}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
