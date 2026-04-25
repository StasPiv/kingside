import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { LatestCoursesBlock } from '../components/lessons/LatestCoursesBlock';
import { CourseAuthorsBlock } from '../components/lessons/CourseAuthorsBlock';

/**
 * `/lessons/discover` — выделенная Discovery-страница (KS-1923,
 * ADR-031 §3 гибрид A+B).
 *
 * `/lessons` остаётся главной с компактной discovery-полоской
 * (`<CommunityStripBlock />`); полные сетки `LatestCoursesBlock`
 * и `CourseAuthorsBlock` живут здесь.
 *
 * Без ProtectedRoute — каталог доступен гостям. Если они кликают
 * по карточке curse, защищённые маршруты (`/lessons/my/<slug>`)
 * сами потребуют логин если необходимо.
 *
 * Полный список авторов — на этой же странице (через
 * `<CourseAuthorsBlock />`). Дублирующий таб «Authors» на
 * `/players` (KS-1920) остаётся — там удобнее искать автора
 * среди players, а не курсов.
 */

export function DiscoverCoursesPage() {
  const { t } = useTranslation();

  // SEO + tab-title.
  useEffect(() => {
    const prevTitle = document.title;
    document.title = `${t('lessons.discover.title', 'Discover courses')} — Kingside`;
    return () => {
      document.title = prevTitle;
    };
  }, [t]);

  return (
    <div className="discover-courses-page" data-testid="discover-courses-page">
      <nav className="discover-courses-page__breadcrumb">
        <Link to="/lessons">{t('lessons.title', 'Lessons')}</Link>
        <span className="discover-courses-page__sep">/</span>
        <span aria-current="page">
          {t('lessons.discover.breadcrumb', 'Discover')}
        </span>
      </nav>

      <header className="discover-courses-page__header">
        <h1>{t('lessons.discover.title', 'Discover courses')}</h1>
        <p className="discover-courses-page__subtitle">
          {t(
            'lessons.discover.subtitle',
            'Latest community courses and the authors behind them.',
          )}
        </p>
      </header>

      <LatestCoursesBlock />

      <CourseAuthorsBlock />
    </div>
  );
}
