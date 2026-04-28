import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FeatureFlags } from '@kingside/shared';
import { FeedbackModal } from './FeedbackModal';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

interface NavItem {
  path: string;
  icon: string;
  i18nKey: string;
  match: string[];
  /**
   * KS-2105: ключ feature-flag из `FeatureFlags`. Если задан — пункт
   * рендерится только когда соответствующий флаг включён через
   * `FeatureFlagsContext` (источник — backend `GET /config`).
   */
  featureFlag?: keyof FeatureFlags;
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
    // KS-2105: раздел скрывается, когда админ выключил
    // `lessonsEnabled` через PATCH /admin/feature-flags/lessonsEnabled.
    featureFlag: 'lessonsEnabled',
  },
  { path: '/workshop', icon: '🔬', i18nKey: 'nav.workshop', match: ['/workshop', '/analysis'] },
  // KS-2066 (F0/ADR-033 §2): namespace архива — рядом с workshop.
  // i18n-ключ — отдельный namespace `archive` (`archive.menuTitle`),
  // см. `apps/web/src/i18n/locales/{ru,en}/archive.json`.
  { path: '/archive', icon: '🗂', i18nKey: 'archive:menuTitle', match: ['/archive'] },
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
  // KS-2105: runtime feature-flags из контекста (backend `GET /config`).
  const { flags } = useFeatureFlags();

  const isActive = (match: string[]) => match.some((p) => location.pathname.startsWith(p));

  const visibleItems = NAV_ITEMS.filter((it) => {
    if (it.featureFlag && !flags[it.featureFlag]) return false;
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
