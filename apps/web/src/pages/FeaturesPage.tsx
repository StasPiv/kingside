import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

const SECTIONS = ['play', 'analyze', 'puzzles', 'workshop', 'broadcasts', 'social', 'customize', 'rating'] as const;
const ICONS: Record<string, string> = {
  play: '♟', analyze: '🔍', puzzles: '🧩', workshop: '🛠',
  broadcasts: '📡', social: '👥', customize: '🎨', rating: '📊',
};

export function FeaturesPage() {
  const { t } = useTranslation();
  const { hash } = useLocation();

  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [hash]);

  return (
    <div className="features-page">
      {/* HERO */}
      <section className="features-hero">
        <h1 className="features-hero__title">{t('features.hero.title')}</h1>
        <p className="features-hero__subtitle">{t('features.hero.subtitle')}</p>
        <div className="features-hero__cta">
          <Link to="/register" className="features-btn features-btn--primary">{t('features.hero.ctaPlay')}</Link>
          <a href="#play" className="features-btn features-btn--secondary">{t('features.hero.ctaLearn')}</a>
        </div>
      </section>

      {/* Quick links for guests */}
      <section className="features-quick-links">
        <div className="features-quick-links__grid">
          <Link to="/lobby" className="features-quick-link">
            <span className="features-quick-link__icon">♟</span>
            <span className="features-quick-link__label">{t('features.play.title', 'Play')}</span>
          </Link>
          <Link to="/puzzles" className="features-quick-link">
            <span className="features-quick-link__icon">🧩</span>
            <span className="features-quick-link__label">{t('features.puzzles.title', 'Puzzles')}</span>
          </Link>
          <Link to="/analysis/new" className="features-quick-link">
            <span className="features-quick-link__icon">🔍</span>
            <span className="features-quick-link__label">{t('features.analyze.title', 'Analysis')}</span>
          </Link>
          <Link to="/broadcasts" className="features-quick-link">
            <span className="features-quick-link__icon">📡</span>
            <span className="features-quick-link__label">{t('features.broadcasts.title', 'Broadcasts')}</span>
          </Link>
          <Link to="/games/live" className="features-quick-link">
            <span className="features-quick-link__icon">👁</span>
            <span className="features-quick-link__label">{t('lobby.watchLive', 'Live Games')}</span>
          </Link>
        </div>
      </section>

      {/* Guide sections */}
      {SECTIONS.map((key) => (
        <section key={key} id={key} className={`features-section features-section--${key}`}>
          <div className="features-section__inner">
            <span className="features-section__icon">{ICONS[key]}</span>
            <h2 className="features-section__title">{t(`features.${key}.title`)}</h2>
            <div className="features-section__guide">
              {t(`features.${key}.guide`).split('\n').map((line, i) => (
                <p key={i} className={line.trim() === '' ? 'features-section__spacer' : undefined}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        </section>
      ))}

      {/* CTA Footer */}
      <section className="features-cta-footer">
        <h2 className="features-cta-footer__title">{t('features.cta.title')}</h2>
        <Link to="/register" className="features-btn features-btn--primary">{t('features.cta.button')}</Link>
      </section>
    </div>
  );
}
