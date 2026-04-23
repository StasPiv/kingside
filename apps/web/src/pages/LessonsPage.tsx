import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseListItem, CourseLevel } from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { LevelGateBanner } from '../components/lessons/LevelGateBanner';

/**
 * Страница `/lessons` — список курсов (L-07).
 *
 * Показывает все опубликованные курсы, сгруппированные по уровню. Если API
 * вернул `recommendedLevel` — курсы этого уровня получают бейдж «Рекомендуем».
 * Полноценный рекомендатор — в L-12; здесь заглушка: бейдж выводится, но
 * `recommendedLevel` может отсутствовать в ответе.
 */

const LEVEL_ORDER: CourseLevel[] = ['beginner', 'intermediate', 'advanced'];

function levelLabelKey(level: CourseLevel): string {
  return `lessons.level.${level}`;
}

export function LessonsPage() {
  const { t } = useTranslation();
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [recommendedLevel, setRecommendedLevel] = useState<CourseLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    lessonsApi
      .listCourses()
      .then((res) => {
        if (cancelled) return;
        setCourses(res.data ?? []);
        setRecommendedLevel(res.recommendedLevel ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('lessons.loadError', 'Failed to load courses'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const grouped = LEVEL_ORDER.map((level) => ({
    level,
    items: courses
      .filter((c) => c.level === level)
      .sort((a, b) => a.order - b.order),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="lessons-page" data-testid="lessons-page">
      <header className="lessons-header">
        <h1>{t('lessons.title', 'Lessons')}</h1>
        <p className="lessons-subtitle">
          {t('lessons.subtitle', 'Structured chess curriculum')}
        </p>
      </header>

      <LevelGateBanner restrictTo="beginner" testId="lessons-page-level-gate" />

      {loading && (
        <div className="loading" data-testid="lessons-loading">
          {t('common.loading')}
        </div>
      )}

      {error && (
        <div className="error" data-testid="lessons-error">
          {error}
        </div>
      )}

      {!loading && !error && grouped.length === 0 && (
        <div className="lessons-empty" data-testid="lessons-empty">
          {t('lessons.empty', 'No courses available yet')}
        </div>
      )}

      {!loading && !error &&
        grouped.map(({ level, items }) => (
          <section
            key={level}
            className="lessons-level-section"
            data-testid={`lessons-level-${level}`}
          >
            <h2 className="lessons-level-title">
              {t(levelLabelKey(level))}
              {recommendedLevel === level && (
                <span
                  className="lessons-recommended-badge"
                  data-testid="lessons-recommended-badge"
                >
                  {t('lessons.recommendedForYou', 'Recommended for you')}
                </span>
              )}
            </h2>
            <ul className="lessons-course-grid">
              {items.map((course) => (
                <li key={course.id} className="lessons-course-card">
                  <Link
                    to={`/lessons/${course.slug}`}
                    className="lessons-course-link"
                    data-testid={`course-link-${course.slug}`}
                  >
                    <h3 className="lessons-course-title">
                      {t(course.titleI18nKey, course.slug)}
                    </h3>
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
    </div>
  );
}
