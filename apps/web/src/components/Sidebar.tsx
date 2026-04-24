import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FeedbackModal } from './FeedbackModal';
import { isLessonsEnabledLive } from '../config/featureFlags';

interface NavItem {
  path: string;
  icon: string;
  i18nKey: string;
  match: string[];
  /** Если задан — пункт рендерится только когда хук вернул true. */
  featureFlag?: () => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/lobby', icon: '🏠', i18nKey: 'nav.home', match: ['/lobby'] },
  { path: '/play', icon: '♟', i18nKey: 'nav.play', match: ['/play'] },
  { path: '/tournaments', icon: '🏆', i18nKey: 'nav.tournaments', match: ['/tournaments'] },
  { path: '/puzzles', icon: '🧩', i18nKey: 'nav.puzzles', match: ['/puzzles', '/puzzle', '/daily'] },
  { path: '/puzzle-rush', icon: '⚡', i18nKey: 'nav.puzzleRush', match: ['/puzzle-rush'] },
  {
    path: '/lessons',
    icon: '📚',
    i18nKey: 'nav.lessons',
    match: ['/lessons'],
    // KS-1820: скрываем раздел целиком при `VITE_FEATURE_LESSONS !== 'true'`.
    featureFlag: isLessonsEnabledLive,
  },
  { path: '/workshop', icon: '🔬', i18nKey: 'nav.workshop', match: ['/workshop', '/analysis'] },
  { path: '/broadcasts', icon: '📺', i18nKey: 'nav.tv', match: ['/broadcasts'] },
  { path: '', icon: '', i18nKey: '', match: [] }, // divider
  { path: '/feedback', icon: '📋', i18nKey: 'nav.feedback', match: ['/feedback'] },
  { path: '/features', icon: '✨', i18nKey: 'nav.features', match: ['/features'] },
  { path: '/friends', icon: '👥', i18nKey: 'nav.friends', match: ['/friends'] },
  { path: '/settings', icon: '⚙', i18nKey: 'nav.settings', match: ['/settings'] },
];

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [showFeedback, setShowFeedback] = useState(false);

  const isActive = (match: string[]) => match.some((p) => location.pathname.startsWith(p));

  const visibleItems = NAV_ITEMS.filter((it) => {
    if (it.featureFlag && !it.featureFlag()) return false;
    return true;
  });

  return (
    <>
      <aside className="sidebar">
        {visibleItems.map((item, i) => {
          if (!item.path) {
            return <div key={i} className="sidebar-divider" />;
          }
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`sidebar-item${isActive(item.match) ? ' sidebar-item--active' : ''}`}
              title={t(item.i18nKey)}
            >
              <span className="sidebar-icon">{item.icon}</span>
            </Link>
          );
        })}
        <div className="sidebar-spacer" />
        <button
          className="sidebar-item sidebar-feedback-btn"
          onClick={() => setShowFeedback(true)}
          title={t('feedback.title', 'Feedback')}
        >
          <span className="sidebar-icon">💬</span>
        </button>
      </aside>
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </>
  );
}
