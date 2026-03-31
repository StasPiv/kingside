import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const NAV_ITEMS = [
  { path: '/lobby', icon: '♟', i18nKey: 'nav.play', match: ['/lobby'] },
  { path: '/tournaments', icon: '🏆', i18nKey: 'nav.tournaments', match: ['/tournaments'] },
  { path: '/puzzles', icon: '🧩', i18nKey: 'nav.puzzles', match: ['/puzzles', '/puzzle', '/daily'] },
  { path: '/puzzle-rush', icon: '⚡', i18nKey: 'nav.puzzleRush', match: ['/puzzle-rush'] },
  { path: '/workshop', icon: '🔬', i18nKey: 'nav.workshop', match: ['/workshop', '/analysis'] },
  { path: '/broadcasts', icon: '📺', i18nKey: 'nav.tv', match: ['/broadcasts'] },
  { path: '', icon: '', i18nKey: '', match: [] }, // divider
  { path: '/features', icon: '✨', i18nKey: 'nav.features', match: ['/features'] },
  { path: '/friends', icon: '👥', i18nKey: 'nav.friends', match: ['/friends'] },
  { path: '/settings', icon: '⚙', i18nKey: 'nav.settings', match: ['/settings'] },
];

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();

  const isActive = (match: string[]) => match.some((p) => location.pathname.startsWith(p));

  return (
    <aside className="sidebar">
      {NAV_ITEMS.map((item, i) => {
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
    </aside>
  );
}
