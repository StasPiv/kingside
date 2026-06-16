import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { SeoHelmet } from '../components/seo/SeoHelmet';
import { landingApi, type LandingStats } from '../api/landingApi';

const SECTIONS = ['play', 'analyze', 'puzzles', 'workshop', 'broadcasts', 'social', 'customize', 'rating'] as const;
const ICONS: Record<string, string> = {
  play: '♟', analyze: '🔍', puzzles: '🧩', workshop: '🛠',
  broadcasts: '📡', social: '👥', customize: '🎨', rating: '📊',
};

/**
 * KS-4267 / ADR-129 §5. Карточки блока «Что есть на платформе» на
 * гостевом лендинге ведут на публичные разделы (см. §6.4 ADR-129).
 * Маршруты выровнены по существующим quick-links в `variant='features'`,
 * чтобы у гостя не было неожиданных редиректов.
 */
const HOME_CARDS = [
  { key: 'play', to: '/play', icon: '♟' },
  { key: 'analyze', to: '/analysis/new', icon: '🔍' },
  { key: 'puzzles', to: '/puzzles', icon: '🧩' },
  { key: 'broadcasts', to: '/broadcasts', icon: '📡' },
  { key: 'social', to: '/players', icon: '👥' },
] as const;

/**
 * KS-4119: `variant='home'` — страница используется как guest-лендинг на `/`.
 * KS-4267 / ADR-129: для `variant='home'` рендерится новая структура
 * (Hero / USP / Cards / Proof / CTA-footer / inline-footer).
 * `variant='features'` (дефолт) — страница используется по прямому URL
 * `/features` (h1 «Features»), оставлен старый Help-каталог с 8 секциями.
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

  const isHome = variant === 'home';

  // KS-4222 / ADR-129 §7. SEO главной и /features. SEO-блок остаётся как
  // в KS-4119 — финальная редакция ключей `landing.seo.*` / переключение
  // canonical и JSON-LD под новые тексты сделает KS-FE-2 / KS-FE-3.
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
      {isHome ? <GuestLandingHome /> : <FeaturesCatalog />}
    </div>
  );
}

/**
 * KS-4267 / ADR-129 §5. Новая структура гостевого лендинга:
 * Hero → USP → Cards → Proof → CTA-footer → inline-footer.
 * Стили — параллельная задача KS-4268 (layout). Здесь только разметка
 * и i18n-ключи `landing.*`.
 */
function GuestLandingHome() {
  const { t } = useTranslation();
  const stats = useLandingStats();

  return (
    <>
      {/* §5.1 Hero */}
      <section className="features-hero landing-hero">
        <h1 className="features-hero__title landing-hero__title">
          {t('landing.hero.title')}
        </h1>
        <p className="features-hero__subtitle landing-hero__subtitle">
          {t('landing.hero.subtitle')}
        </p>
        <div className="features-hero__cta landing-hero__cta">
          <Link
            to="/play/local-bot"
            className="features-btn features-btn--primary"
            data-testid="landing-hero-cta-play"
          >
            {t('landing.hero.ctaPlay')}
          </Link>
          <Link
            to="/register"
            className="features-btn features-btn--secondary"
            data-testid="landing-hero-cta-register"
          >
            {t('landing.hero.ctaRegister')}
          </Link>
          <Link
            to="/login"
            className="landing-hero__login"
            data-testid="landing-hero-cta-login"
          >
            {t('landing.hero.ctaLogin')}
          </Link>
        </div>
      </section>

      {/* §5.2 USP — два пункта с h3 и пояснением */}
      <section className="landing-usp" data-testid="landing-usp">
        <article className="landing-usp__item">
          <span className="landing-usp__icon" aria-hidden="true">🤖</span>
          <h3 className="landing-usp__title">{t('landing.usp.point1.title')}</h3>
          <p className="landing-usp__text">{t('landing.usp.point1.text')}</p>
        </article>
        <article className="landing-usp__item">
          <span className="landing-usp__icon" aria-hidden="true">🧩</span>
          <h3 className="landing-usp__title">{t('landing.usp.point2.title')}</h3>
          <p className="landing-usp__text">{t('landing.usp.point2.text')}</p>
        </article>
      </section>

      {/* §5.3 Cards — 5 публичных разделов */}
      <section className="landing-cards" data-testid="landing-cards">
        <h2 className="landing-cards__title">{t('landing.cards.title')}</h2>
        <div className="landing-cards__grid">
          {HOME_CARDS.map((card) => (
            <Link
              key={card.key}
              to={card.to}
              className="landing-card"
              data-testid={`landing-card-${card.key}`}
            >
              <span className="landing-card__icon" aria-hidden="true">{card.icon}</span>
              <p className="landing-card__text">{t(`landing.cards.${card.key}`)}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* §5.4 Proof — отрисовать ТОЛЬКО при успешном ответе backend'а.
          5xx / timeout / пустые данные → секция не рендерится (по §5.4
          и §10.1 ADR-129). На prerender (бот) `/landing/stats` мокается
          в KS-FE-4 — для KS-FE-1 достаточно условного рендера. */}
      {stats && (
        <section className="landing-proof" data-testid="landing-proof">
          <h2 className="landing-proof__title">{t('landing.proof.title')}</h2>
          <dl className="landing-proof__grid">
            <div className="landing-proof__item" data-testid="landing-proof-online">
              <dt className="landing-proof__value">{formatNumber(stats.onlineNow)}</dt>
              <dd className="landing-proof__label">{t('landing.proof.online')}</dd>
            </div>
            <div className="landing-proof__item" data-testid="landing-proof-games-in-progress">
              <dt className="landing-proof__value">{formatNumber(stats.gamesInProgress)}</dt>
              <dd className="landing-proof__label">{t('landing.proof.gamesInProgress')}</dd>
            </div>
            <div className="landing-proof__item" data-testid="landing-proof-total-games">
              <dt className="landing-proof__value">{formatNumber(stats.totalGames)}</dt>
              <dd className="landing-proof__label">{t('landing.proof.totalGames')}</dd>
            </div>
            <div className="landing-proof__item" data-testid="landing-proof-total-users">
              <dt className="landing-proof__value">{formatNumber(stats.registeredUsers)}</dt>
              <dd className="landing-proof__label">{t('landing.proof.totalUsers')}</dd>
            </div>
            <div className="landing-proof__item" data-testid="landing-proof-total-puzzles">
              <dt className="landing-proof__value">{formatNumber(stats.totalPuzzlesSolved)}</dt>
              <dd className="landing-proof__label">{t('landing.proof.totalPuzzles')}</dd>
            </div>
          </dl>
        </section>
      )}

      {/* §5.5 CTA-footer */}
      <section className="features-cta-footer landing-cta-footer">
        <h2 className="features-cta-footer__title">{t('landing.cta.title')}</h2>
        <Link
          to="/register"
          className="features-btn features-btn--primary"
          data-testid="landing-cta-register"
        >
          {t('landing.cta.button')}
        </Link>
        {/* KS-4104: ссылка на YouTube-канал — сохранена. */}
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

      {/* §5.6 Inline-footer — три ссылки. Селектор языка тут не нужен
          (есть в шапке, по решению layout/KS-4265). */}
      <footer className="landing-footer" data-testid="landing-footer">
        <Link to="/terms" className="landing-footer__link">
          {t('landing.footerLinks.terms')}
        </Link>
        <span className="landing-footer__sep" aria-hidden="true">·</span>
        <Link to="/help/external-engine" className="landing-footer__link">
          {t('landing.footerLinks.externalEngine')}
        </Link>
        <span className="landing-footer__sep" aria-hidden="true">·</span>
        <Link to="/credits" className="landing-footer__link">
          {t('landing.footerLinks.credits')}
        </Link>
      </footer>
    </>
  );
}

/**
 * KS-4119 (KS-4267 — без изменений). `variant='features'` остаётся
 * Help-каталогом: h1 «Features», 5 quick-links, 8 секций с гайдами,
 * CTA-footer. Старая секция `#navigation` (changelog меню май 2026)
 * удалена — её ключи `features.navigation.*` убраны из i18n по
 * ADR-129 §8.3.
 */
function FeaturesCatalog() {
  const { t } = useTranslation();
  return (
    <>
      <section className="features-hero">
        <h1 className="features-hero__title">
          {t('features.page.title', 'Features')}
        </h1>
        <p className="features-hero__subtitle">
          {t('features.page.subtitle', 'Everything Kingside has to offer')}
        </p>
        <div className="features-hero__cta">
          <Link to="/register" className="features-btn features-btn--primary">
            {t('features.hero.ctaPlay')}
          </Link>
          <a href="#play" className="features-btn features-btn--secondary">
            {t('features.hero.ctaLearn')}
          </a>
        </div>
      </section>

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

      <section className="features-cta-footer">
        <h2 className="features-cta-footer__title">{t('features.cta.title')}</h2>
        <Link to="/register" className="features-btn features-btn--primary">
          {t('features.cta.button')}
        </Link>
        {/* KS-4104: YouTube-ссылка. */}
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
    </>
  );
}

/**
 * KS-4267 / ADR-129 §5.4. Загрузка статистики для блока «Proof».
 * Возвращает `null` пока запрос не завершился ИЛИ если упал
 * (5xx/timeout/network). Компонент не рендерит блок при `null` —
 * это и есть «graceful degradation» из §10.1.
 *
 * Префетчинг/prerender-мок — отдельная задача KS-FE-4; здесь хук
 * вызывает API при монтировании на клиенте.
 */
function useLandingStats(): LandingStats | null {
  const [stats, setStats] = useState<LandingStats | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    landingApi
      .getStats(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setStats(data);
      })
      .catch(() => {
        // 5xx / timeout / network → блок не рендерится.
      });
    return () => ctrl.abort();
  }, []);

  return stats;
}

/**
 * KS-4267 / ADR-129 §5.4. Форматирование чисел: `1234` → `1 234`.
 * Локализованный разделитель тысяч — `Intl.NumberFormat` берёт текущую
 * локаль браузера, в проде совпадает с языком интерфейса.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  try {
    return new Intl.NumberFormat().format(value);
  } catch {
    return String(value);
  }
}
