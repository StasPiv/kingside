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
import { LessonsHero } from '../components/lessons/LessonsHero';
import { CommunityStripBlock } from '../components/lessons/CommunityStripBlock';
import { CurriculumPillarBlock } from '../components/lessons/CurriculumPillarBlock';

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

      {/* KS-1922 / ADR-031 §4.1: контекстный hero — 5 вариантов
          (continue / author / start / guest / loading) в зависимости
          от состояния пользователя. */}
      <LessonsHero />

      <ReviewsDueBlock items={reviewsDue} errored={reviewsDueErrored} />

      <MistakesDiaryBlock
        aggregates={mistakeAggregates}
        totalThemes={mistakeTotalThemes}
        errored={mistakesErrored}
      />

      <LevelGateBanner restrictTo="beginner" testId="lessons-page-level-gate" />

      {/* ADR-031 §5: порядок L2 Personal/Daily/Active learning. */}
      {/* KS-1840: «Мои курсы» — скрыт при отсутствии своих курсов. */}
      <MyCoursesBlock />

      {/* KS-1890: «Курсы, которые я прохожу» — скрыт при отсутствии
          enrolled. */}
      <EnrolledCoursesBlock />

      {/* KS-1923 / ADR-031 §2: L3 Curriculum pillar — структурированный
          путь Beginner → Intermediate → Advanced. */}
      <CurriculumPillarBlock
        groups={grouped}
        recommendedLevel={recommendedLevel}
        loading={loading}
        error={error}
        emptyText={t('lessons.empty', 'No courses available yet')}
      />

      {/* KS-1923 / ADR-031 §3: L4 Discovery — компактная полоса
          последних public курсов с CTA «Все курсы и авторы»
          → /lessons/discover. Полные сетки LatestCoursesBlock и
          CourseAuthorsBlock переехали туда. */}
      <CommunityStripBlock />
    </div>
  );
}
