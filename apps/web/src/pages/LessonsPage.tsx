import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { MyCoursesView } from '../components/lessons/views/MyCoursesView';
import { LazySection } from '../components/lessons/LazySection';
import { useAuth } from '../context/AuthContext';

/**
 * Страница `/lessons` — список курсов (L-07).
 *
 * Показывает все опубликованные курсы, сгруппированные по уровню. Если API
 * вернул `recommendedLevel` — курсы этого уровня получают бейдж «Рекомендуем».
 *
 * # KS-2650 — объединение `/lessons` и `/lessons/my`
 *
 * После Phase D ADR-054 (KS-2645) системные и пользовательские курсы —
 * единая модель. Держать второй пункт «Мои курсы» в Sidebar (🎒) и
 * отдельную страницу `/lessons/my` стало артефактом — KS-2650 объединяет
 * это в один пункт «🎓 Курсы» (`/lessons`) с табом-переключателем
 * «Все / Мои» через query-параметр `?tab=all|mine`.
 *
 * Маршрут `/lessons/my` редиректится на `/lessons?tab=mine` через
 * `<Navigate>` в App.tsx — старые ссылки сохраняются.
 *
 * Для гостей таб «Мои» скрыт (нечего показывать без авторизации).
 */

const LEVEL_ORDER: CourseLevel[] = ['beginner', 'intermediate', 'advanced'];

type LessonsTab = 'all' | 'mine';

function parseTab(value: string | null): LessonsTab {
  return value === 'mine' ? 'mine' : 'all';
}

export function LessonsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // KS-2650: таб берём из URL `?tab=all|mine`. Default — `all`.
  // Гостям таб `mine` не доступен — если в URL пришёл `mine` без auth,
  // схлопываем на `all` (login-fallback внутри MyCoursesView тоже
  // сработает, но лучше не показывать кнопку «Мои» гостям вовсе).
  const requestedTab = parseTab(searchParams.get('tab'));
  const tab: LessonsTab = !user && requestedTab === 'mine' ? 'all' : requestedTab;

  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [recommendedLevel, setRecommendedLevel] = useState<CourseLevel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewsDue, setReviewsDue] = useState<ReviewDueItem[]>([]);
  const [reviewsDueErrored, setReviewsDueErrored] = useState(false);
  // KS-1928: «Дневник ошибок» переехал из /lessons в /puzzles namespace
  // (см. PuzzleStatsPage и compact hint на /puzzle). На /lessons его
  // больше нет — здесь только learning-контент.

  // KS-2102: API больше НЕ принимает `?lang=` — backend читает
  // `User.locale` сам. Но мы оставляем `lang` в зависимости effect'а
  // как триггер рефетча: переключатель в шапке делает PATCH
  // /users/me/settings, потом `i18n.changeLanguage`; смена
  // `i18n.language` инвалидирует наш список (как react-query
  // invalidate) и effect повторно ходит в API — backend отдаст
  // курсы под новой `User.locale`.
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
  }, [t, lang]);

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

  const setTab = (next: LessonsTab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('tab');
    else sp.set('tab', next);
    setSearchParams(sp, { replace: false });
  };

  return (
    <div
      className="lessons-page"
      data-testid="lessons-page"
      data-tab={tab}
    >
      <header className="lessons-header">
        <h1>{t('lessons.title', 'Lessons')}</h1>
        <p className="lessons-subtitle">
          {t('lessons.subtitle', 'Structured chess curriculum')}
        </p>
        {/* KS-2650: табы «Все / Мои» — простое переключение источника
            списка курсов. Гостям таб «Мои» не показываем — нечего там
            показывать без авторизации. */}
        {user && (
          <nav
            className="lessons-tabs"
            data-testid="lessons-tabs"
            aria-label={t('lessons.tabs.label', 'Course list filter')}
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'all'}
              className={`lessons-tab${tab === 'all' ? ' lessons-tab--active' : ''}`}
              data-testid="lessons-tab-all"
              onClick={() => setTab('all')}
            >
              {t('lessons.tabs.all', 'All')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mine'}
              className={`lessons-tab${tab === 'mine' ? ' lessons-tab--active' : ''}`}
              data-testid="lessons-tab-mine"
              onClick={() => setTab('mine')}
            >
              {t('lessons.tabs.mine', 'My courses')}
            </button>
          </nav>
        )}
      </header>

      {/* KS-2650: на табе «Мои» рендерим MyCoursesView (бывшая
          MyCoursesPage без breadcrumb/H1) и больше ничего. Hero,
          curriculum, community-strip и т.п. — только на табе «Все». */}
      {tab === 'mine' && <MyCoursesView />}
      {tab === 'all' && (
      <>

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
          emptyText={t(
            'lessons.emptyForLang',
            'No courses are available in your language yet',
          )}
        />
      </LazySection>

      {/* KS-1940 (F-3): CTA «+ Создать свой курс» одной строкой над
          секцией «Сообщество». Гостям не показываем (внутри сам
          возвращает null).
          KS-2650: убрали `<MyCoursesEntryCta>` — переход на «Мои»
          теперь делает таб в шапке. */}
      <div className="lessons-author-cta-row" data-testid="lessons-author-cta-row">
        <CreateCourseCta />
      </div>

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
      </>
      )}
    </div>
  );
}
