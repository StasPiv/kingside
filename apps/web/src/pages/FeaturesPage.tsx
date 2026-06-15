import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { SeoHelmet } from '../components/seo/SeoHelmet';

const SECTIONS = ['play', 'analyze', 'puzzles', 'workshop', 'broadcasts', 'social', 'customize', 'rating'] as const;
const ICONS: Record<string, string> = {
  play: '♟', analyze: '🔍', puzzles: '🧩', workshop: '🛠',
  broadcasts: '📡', social: '👥', customize: '🎨', rating: '📊',
};

/**
 * KS-4119: `variant='home'` — страница используется как guest-лендинг на `/`
 * (брендовый h1 «Play chess. Analyze. Improve.»). `variant='features'` (дефолт)
 * — страница используется по прямому URL `/features` (h1 «Features»), чтобы
 * prerender для `/` и `/features` отдавал РАЗНЫЕ h1 (не дубль-контент в SEO).
 */
export function FeaturesPage({ variant = 'features' }: { variant?: 'home' | 'features' }) {
  const { t } = useTranslation();
  const { hash } = useLocation();

  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [hash]);

  const heroTitle =
    variant === 'home'
      ? t('features.hero.title')
      : t('features.page.title', 'Features');
  const heroSubtitle =
    variant === 'home'
      ? t('features.hero.subtitle')
      : t('features.page.subtitle', 'Everything Kingside has to offer');

  // KS-4222 / ADR-129 §7. SEO главной и /features. На главной — самый
  // ценный URL: title с ключевыми словами, JSON-LD WebSite +
  // Organization. На /features — отдельные ключи, чтобы prerender
  // отдавал per-page title (не дубль-контент с главной).
  const isHome = variant === 'home';
  const seoTitle = t(isHome ? 'seo.home.title' : 'seo.features.title');
  const seoDescription = t(
    isHome ? 'seo.home.description' : 'seo.features.description',
  );
  const seoCanonical = isHome
    ? 'https://kingside.site/'
    : 'https://kingside.site/features';
  const seoJsonLd = isHome
    ? [
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Kingside',
          url: 'https://kingside.site/',
          description: seoDescription,
          inLanguage: ['en', 'ru'],
          potentialAction: {
            '@type': 'SearchAction',
            target:
              'https://kingside.site/players?search={search_term_string}',
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'Kingside',
          url: 'https://kingside.site/',
          logo: 'https://kingside.site/icon.svg',
        },
      ]
    : undefined;

  return (
    <div className="features-page">
      <SeoHelmet
        title={seoTitle}
        description={seoDescription}
        canonical={seoCanonical}
        ogType="website"
        ogImage="/og/default.png"
        jsonLd={seoJsonLd}
      />
      {/* HERO */}
      <section className="features-hero">
        <h1 className="features-hero__title">{heroTitle}</h1>
        <p className="features-hero__subtitle">{heroSubtitle}</p>
        <div className="features-hero__cta">
          <Link to="/register" className="features-btn features-btn--primary">{t('features.hero.ctaPlay')}</Link>
          <a href="#play" className="features-btn features-btn--secondary">{t('features.hero.ctaLearn')}</a>
        </div>
      </section>

      {/* KS-2814 (ADR-058 §6.7 T17): запись о ревизии навигации.
          Якорь #navigation сохранён — на него до KS-3070 указывала кнопка
          «Read more» в NavOnboardingTooltip; внешние ссылки/закладки
          могли остаться. */}
      <section
        id="navigation"
        className="features-section features-section--changelog"
      >
        <div className="features-section__inner">
          <span className="features-section__icon">🧭</span>
          <h2 className="features-section__title">
            {t('features.navigation.title', 'Menu reorganized (May 2026)')}
          </h2>
          <div className="features-section__guide">
            <p>
              {t(
                'features.navigation.intro',
                'We reorganized the sidebar into 5 main groups. Direct URLs still work — only the menu structure changed.',
              )}
            </p>
            <ul>
              <li>
                {t(
                  'features.navigation.bullet1',
                  'Puzzles, Puzzle Rush, Drills and Precision are now grouped under "Train" (/train).',
                )}
              </li>
              <li>
                {t(
                  'features.navigation.bullet2',
                  'Workshop and Archive are under "Analyze" (/analyze).',
                )}
              </li>
              <li>
                {t(
                  'features.navigation.bullet3',
                  '"Home" and "Tournaments" were removed from the menu but remain available by direct link (/lobby, /tournaments).',
                )}
              </li>
              <li>
                {t(
                  'features.navigation.bullet4',
                  'After login you land on /play instead of /lobby.',
                )}
              </li>
              <li>
                {t(
                  'features.navigation.bullet5',
                  'On desktop, "Train" and "Analyze" subsections open directly from the sidebar via hover/click — no intermediate lobby page.',
                )}
              </li>
            </ul>
          </div>
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
        {/* KS-4104: ссылка на YouTube-канал с видеообзорами разделов.
            Новая вкладка, rel=noopener. Переиспользует стиль вторичной
            кнопки для консистентности. */}
        <a
          className="features-btn features-btn--secondary features-youtube-link"
          href="https://www.youtube.com/@kingside_site"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="features-youtube-link"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            aria-hidden="true"
            style={{ verticalAlign: 'text-bottom', marginRight: 8 }}
          >
            <path
              fill="#FF0000"
              d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8z"
            />
            <path fill="#fff" d="M9.6 15.6V8.4l6.2 3.6z" />
          </svg>
          {t('features.cta.youtube', 'Video reviews on YouTube')}
        </a>
      </section>
    </div>
  );
}
