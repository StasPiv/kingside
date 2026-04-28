import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CourseListItem,
  CourseLevel,
  ReviewDueItem,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { ReviewsDueBlock } from '../components/lessons/ReviewsDueBlock';
import { LessonsHero } from '../components/lessons/LessonsHero';
import { CommunityStripBlock } from '../components/lessons/CommunityStripBlock';
import { CurriculumPillarBlock } from '../components/lessons/CurriculumPillarBlock';
import { RecommendedCoursesBlock } from '../components/lessons/RecommendedCoursesBlock';
import { CreateCourseCta } from '../components/lessons/CreateCourseCta';
import { LazySection } from '../components/lessons/LazySection';

/**
 * Страница `/lessons` — список курсов (L-07).
 *
 * Показывает все опубликованные курсы, сгруппированные по уровню. Если API
 * вернул `recommendedLevel` — курсы этого уровня получают бейдж «Рекомендуем».
 * Полноценный рекомендатор — в L-12; здесь заглушка: бейдж выводится, но
 * `recommendedLevel` может отсутствовать в ответе.
 */

const LEVEL_ORDER: CourseLevel[] = ['beginner', 'intermediate', 'advanced'];

export function LessonsPage() {
  const { t } = useTranslation();
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [recommendedLevel, setRecommendedLevel] = useState<CourseLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewsDue, setReviewsDue] = useState<ReviewDueItem[]>([]);
  const [reviewsDueErrored, setReviewsDueErrored] = useState(false);
  // KS-1928: «Дневник ошибок» переехал из /lessons в /puzzles namespace
  // (см. PuzzleStatsPage и compact hint на /puzzle). На /lessons его
  // больше нет — здесь только learning-контент.

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

      {/* KS-1922 / ADR-031 §4.1: контекстный hero — 5 вариантов
          (continue / author / start / guest / loading) в зависимости
          от состояния пользователя. */}
      <LessonsHero />

      <ReviewsDueBlock items={reviewsDue} errored={reviewsDueErrored} />

      {/* KS-1944 / §3: «Рекомендуем вам» — между Hero/Reviews и
          системными/пользовательскими блоками. Lazy-mount: запрос
          уходит только при пересечении с viewport, чтобы не
          грузить выше-сгиба второй раз. */}
      <LazySection
        testId="recommended-courses-lazy"
        fallback={
          <section
            className="recommended-courses-block recommended-courses-block--placeholder"
            data-testid="recommended-courses-placeholder"
            aria-busy="true"
          >
            <div className="recommended-courses-block__skeleton-title" />
            <div className="recommended-courses-block__skeleton-row" />
          </section>
        }
      >
        <RecommendedCoursesBlock />
      </LazySection>

      {/* KS-1940 (F-3): MyCoursesBlock и EnrolledCoursesBlock убраны с
          главной — активные курсы пользователя теперь показываются в
          Hero (variant continue/multi) или на /lessons/my-active
          (KS-1941, F-4). Список созданных курсов автора уезжает на
          ту же страницу my-active. */}

      {/* KS-1923 / ADR-031 §2: L3 Curriculum pillar — структурированный
          путь Beginner → Intermediate → Advanced.
          KS-1924: lazy-mount через IntersectionObserver. До пересечения
          с viewport (rootMargin=200px) — компактный плейсхолдер той
          же высоты, чтобы избежать layout-shift. */}
      <LazySection
        testId="curriculum-pillar-lazy"
        fallback={
          <section
            className="curriculum-pillar-block curriculum-pillar-block--placeholder"
            data-testid="curriculum-pillar-placeholder"
            aria-busy="true"
          >
            <div className="curriculum-pillar-block__skeleton-title" />
            <div className="curriculum-pillar-block__skeleton-row" />
            <div className="curriculum-pillar-block__skeleton-row" />
          </section>
        }
      >
        <CurriculumPillarBlock
          groups={grouped}
          recommendedLevel={recommendedLevel}
          loading={loading}
          error={error}
          emptyText={t('lessons.empty', 'No courses available yet')}
        />
      </LazySection>

      {/* KS-1940 (F-3): CTA «+ Создать свой курс» одной строкой над
          секцией «Сообщество». Гостям не показываем (внутри сам
          возвращает null). */}
      <CreateCourseCta />

      {/* KS-1923 / ADR-031 §3: L4 Discovery — компактная полоса
          последних public курсов с CTA «Все курсы и авторы»
          → /lessons/discover. Полные сетки LatestCoursesBlock и
          CourseAuthorsBlock переехали туда.
          KS-1924: lazy-mount — `userCoursesApi.listLatest` запрос
          уходит только когда секция близка к viewport. */}
      <LazySection
        testId="community-strip-lazy"
        fallback={
          <section
            className="community-strip-block community-strip-block--placeholder"
            data-testid="community-strip-placeholder"
            aria-busy="true"
          >
            <div className="community-strip-block__skeleton-heading" />
            <ul className="community-strip-block__list community-strip-block__list--skeleton">
              {[0, 1, 2, 3, 4].map((i) => (
                <li
                  key={i}
                  className="community-strip-block__card community-strip-block__card--skeleton"
                  aria-hidden="true"
                >
                  <div className="community-strip-block__skeleton-title" />
                  <div className="community-strip-block__skeleton-line" />
                </li>
              ))}
            </ul>
          </section>
        }
      >
        <CommunityStripBlock />
      </LazySection>
    </div>
  );
}
