import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  CourseListItem,
  CourseLevel,
  ReviewDueItem,
  UserMistakeAggregate,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { LevelGateBanner } from '../components/lessons/LevelGateBanner';
import { ReviewsDueBlock } from '../components/lessons/ReviewsDueBlock';
import { MistakesDiaryBlock } from '../components/lessons/MistakesDiaryBlock';
import { MyCoursesBlock } from '../components/lessons/MyCoursesBlock';
import { EnrolledCoursesBlock } from '../components/lessons/EnrolledCoursesBlock';
import { LatestCoursesBlock } from '../components/lessons/LatestCoursesBlock';
import { CourseAuthorsBlock } from '../components/lessons/CourseAuthorsBlock';

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
  const [reviewsDue, setReviewsDue] = useState<ReviewDueItem[]>([]);
  const [reviewsDueErrored, setReviewsDueErrored] = useState(false);
  const [mistakeAggregates, setMistakeAggregates] = useState<UserMistakeAggregate[]>([]);
  const [mistakeTotalThemes, setMistakeTotalThemes] = useState(0);
  const [mistakesErrored, setMistakesErrored] = useState(false);

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

  // SM-2 «К повторению сегодня» (L-22, KS-1799). Ошибка этого запроса не
  // блокирует страницу — блок просто скрывается. Список пустой — блок
  // тоже скрывается (поведение по Gherkin).
  useEffect(() => {
    let cancelled = false;
    setReviewsDueErrored(false);
    lessonsApi
      .getReviewsDue()
      .then((res) => {
        if (cancelled) return;
        setReviewsDue(res.items ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setReviewsDueErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // «Дневник ошибок» (L-31, KS-1802). Топ-5 — значит запрашиваем с
  // limit=5; полный список доступен на /lessons/mistakes.
  useEffect(() => {
    let cancelled = false;
    setMistakesErrored(false);
    lessonsApi
      .getMistakeAggregates({ limit: 5 })
      .then((res) => {
        if (cancelled) return;
        setMistakeAggregates(res.aggregates ?? []);
        setMistakeTotalThemes(res.totalThemes ?? 0);
      })
      .catch(() => {
        if (cancelled) return;
        setMistakesErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

      <ReviewsDueBlock items={reviewsDue} errored={reviewsDueErrored} />

      <MistakesDiaryBlock
        aggregates={mistakeAggregates}
        totalThemes={mistakeTotalThemes}
        errored={mistakesErrored}
      />

      <LevelGateBanner restrictTo="beginner" testId="lessons-page-level-gate" />

      {/* KS-1840: блок «Мои курсы» между LevelGateBanner и системными курсами. */}
      <MyCoursesBlock />

      {/* KS-1890: блок «Курсы, которые я прохожу» — чужие enrolled-not-owned
          курсы. Скрывается, если список пуст. */}
      <EnrolledCoursesBlock />

      {/* KS-1919 / ADR-030 §2.1: лента последних публичных курсов
          (исключая свои). Скрывается при пустом / loading / error. */}
      <LatestCoursesBlock />

      {/* KS-1919 / ADR-030 §2.2: топ-12 авторов по числу публичных
          курсов. С кнопкой «All authors» → /players?tab=authors. */}
      <CourseAuthorsBlock />

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
