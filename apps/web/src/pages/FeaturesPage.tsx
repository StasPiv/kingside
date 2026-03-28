import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const SECTIONS = ['play', 'analyze', 'puzzles', 'workshop', 'broadcasts', 'social', 'customize'] as const;
const ICONS: Record<string, string> = {
  play: '♟', analyze: '🔍', puzzles: '🧩', workshop: '🛠',
  broadcasts: '📡', social: '👥', customize: '🎨',
};

export function FeaturesPage() {
  const { t } = useTranslation();

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

      {/* Feature sections */}
      {SECTIONS.map((key) => (
        <section key={key} id={key} className={`features-section features-section--${key}`}>
          <div className="features-section__inner">
            <span className="features-section__icon">{ICONS[key]}</span>
            <h2 className="features-section__title">{t(`features.${key}.title`)}</h2>
            <p className="features-section__desc">{t(`features.${key}.description`)}</p>
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
