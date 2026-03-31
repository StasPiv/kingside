import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function MobileBottomBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (paths: string[]) => paths.some((p) => location.pathname.startsWith(p));

  return (
    <div className="mobile-bottom-bar">
      <Link to="/lobby" className={`mobile-bar-item${isActive(['/lobby']) ? ' mobile-bar-item--active' : ''}`}>
        <span className="mobile-bar-icon">♟</span>
        <span className="mobile-bar-label">{t('nav.play', 'Play')}</span>
      </Link>
      <Link to="/tournaments" className={`mobile-bar-item${isActive(['/tournaments']) ? ' mobile-bar-item--active' : ''}`}>
        <span className="mobile-bar-icon">🏆</span>
        <span className="mobile-bar-label">{t('nav.tournaments', 'Tournaments')}</span>
      </Link>
      <Link to="/daily" className={`mobile-bar-item${isActive(['/daily', '/puzzles', '/puzzle-rush', '/puzzle']) ? ' mobile-bar-item--active' : ''}`}>
        <span className="mobile-bar-icon">🧩</span>
        <span className="mobile-bar-label">{t('nav.puzzles', 'Puzzles')}</span>
      </Link>
      <Link to="/workshop" className={`mobile-bar-item${isActive(['/workshop', '/analysis']) ? ' mobile-bar-item--active' : ''}`}>
        <span className="mobile-bar-icon">🔬</span>
        <span className="mobile-bar-label">{t('nav.workshop', 'Workshop')}</span>
      </Link>
      <button className={`mobile-bar-item${moreOpen ? ' mobile-bar-item--active' : ''}`} onClick={() => setMoreOpen(!moreOpen)}>
        <span className="mobile-bar-icon">⋯</span>
        <span className="mobile-bar-label">{t('nav.more', 'More')}</span>
      </button>
      {moreOpen && (
        <div className="mobile-more-menu" onClick={() => setMoreOpen(false)}>
          <Link to="/broadcasts">{t('nav.tv', 'TV')}</Link>
          <Link to="/features">{t('nav.features', 'Features')}</Link>
          <Link to="/friends">{t('nav.friends', 'Friends')}</Link>
          <Link to="/settings">{t('nav.settings', 'Settings')}</Link>
          <Link to="/profile">{t('nav.profile', 'Profile')}</Link>
        </div>
      )}
    </div>
  );
}
