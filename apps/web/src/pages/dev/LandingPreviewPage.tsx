/**
 * KS-4268 dev-only песочница: рендерит разметку шести блоков нового
 * гостевого лендинга (ADR-129 §5) с фикстурами для приёмочных
 * скриншотов. Frontend (KS-4267) использует тот же набор классов
 * `landing-*` — превью гарантирует визуальное соответствие.
 *
 * Доступ: `/__dev/landing`. Переключатель темы — сверху.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

type Theme = 'dark' | 'light';

interface UspFixture {
  icon: string;
  title: string;
  text: string;
}

interface CardFixture {
  icon: string;
  title: string;
  text: string;
  href: string;
}

interface ProofFixture {
  value: string;
  label: string;
}

const USPS: UspFixture[] = [
  {
    icon: '⚡',
    title: 'Играй сразу — без регистрации',
    text: 'Сыграй партию с ботом прямо с главной. Регистрация — потом, если понравится.',
  },
  {
    icon: '🎯',
    title: 'Бесплатно и без рекламы',
    text: 'Открытые ассеты, локальный движок Stockfish. Никаких баннеров и платных стен.',
  },
];

const CARDS: CardFixture[] = [
  {
    icon: '♟️',
    title: 'Партии',
    text: 'Блиц, рапид и классика против людей или ботов.',
    href: '/play/local-bot',
  },
  {
    icon: '🧩',
    title: 'Задачи',
    text: 'Тысячи позиций с раздачей по рейтингу.',
    href: '/puzzles',
  },
  {
    icon: '📚',
    title: 'Уроки',
    text: 'Курсы по дебютам, эндшпилю и стратегии.',
    href: '/lessons',
  },
  {
    icon: '🔬',
    title: 'Анализ',
    text: 'Stockfish 18 локально в браузере, дерево вариантов.',
    href: '/analysis',
  },
  {
    icon: '📺',
    title: 'Трансляции',
    text: 'Турниры Lichess в реальном времени с часами.',
    href: '/broadcasts',
  },
];

const PROOF: ProofFixture[] = [
  { value: '14', label: 'Онлайн сейчас' },
  { value: '83', label: 'Партий сегодня' },
  { value: '1 240', label: 'Задач решено' },
  { value: '46', label: 'Курсов' },
  { value: '6', label: 'Трансляций' },
];

export default function LandingPreviewPage() {
  const [theme, setTheme] = useState<Theme>('dark');

  return (
    <div data-theme={theme} style={{ background: 'var(--bg-canvas)' }}>
      {/* Превью-toolbar — не входит в боевой лендинг. */}
      <div
        style={{
          position: 'sticky',
          top: 56,
          zIndex: 10,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '6px 12px',
          margin: '12px auto',
          maxWidth: 'fit-content',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-mid)',
          borderRadius: 8,
          color: 'var(--text-primary)',
          fontSize: 12,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>KS-4268 · theme:</span>
        {(['dark', 'light'] as Theme[]).map((tt) => (
          <button
            key={tt}
            type="button"
            onClick={() => setTheme(tt)}
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--border-mid)',
              background:
                theme === tt ? 'var(--accent-primary)' : 'transparent',
              color:
                theme === tt ? 'var(--text-on-accent)' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            {tt}
          </button>
        ))}
      </div>

      <div className="landing-page">
        {/* ---------- Блок 1: HERO ---------- */}
        <section className="landing-hero">
          <span className="landing-hero__eyebrow">Шахматная платформа</span>
          <h1 className="landing-hero__title">
            Играй в шахматы без регистрации
          </h1>
          <p className="landing-hero__subtitle">
            Партии с ботами, тренировки задач, локальный анализ Stockfish и
            прямые трансляции турниров — всё на одной странице, без рекламы.
          </p>
          <div className="landing-hero__actions">
            <Link
              to="/play/local-bot"
              className="landing-btn landing-btn--primary"
            >
              Сыграть с ботом
            </Link>
            <Link
              to="/register"
              className="landing-btn landing-btn--secondary"
            >
              Создать аккаунт
            </Link>
          </div>
          <p className="landing-hero__login-link">
            Уже зарегистрирован? <Link to="/login">Войти</Link>
          </p>
        </section>

        {/* ---------- Блок 2: USP ---------- */}
        <section className="landing-usp">
          {USPS.map((u) => (
            <div key={u.title} className="landing-usp__item">
              <span className="landing-usp__icon" aria-hidden="true">
                {u.icon}
              </span>
              <div className="landing-usp__body">
                <h3 className="landing-usp__title">{u.title}</h3>
                <p className="landing-usp__text">{u.text}</p>
              </div>
            </div>
          ))}
        </section>

        {/* ---------- Блок 3: CARDS ---------- */}
        <section className="landing-cards">
          <h2 className="landing-cards__title">Что внутри</h2>
          <div className="landing-cards__grid">
            {CARDS.map((c) => (
              <Link key={c.title} to={c.href} className="landing-card">
                <span className="landing-card__icon" aria-hidden="true">
                  {c.icon}
                </span>
                <h3 className="landing-card__title">{c.title}</h3>
                <p className="landing-card__text">{c.text}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* ---------- Блок 4: PROOF ---------- */}
        <section className="landing-proof">
          <div className="landing-proof__grid">
            {PROOF.map((p) => (
              <div key={p.label} className="landing-proof__item">
                <span className="landing-proof__value">{p.value}</span>
                <span className="landing-proof__label">{p.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- Блок 5: CTA-FOOTER ---------- */}
        <section className="landing-cta">
          <h2 className="landing-cta__title">
            Зарегистрируйся, чтобы сохранять партии и прогресс
          </h2>
          <p className="landing-cta__subtitle">
            Бесплатно. Без рекламы. Без верификации почты — можно сразу.
          </p>
          <div className="landing-cta__actions">
            <Link
              to="/register"
              className="landing-btn landing-btn--primary"
            >
              Создать аккаунт
            </Link>
            <a
              href="https://www.youtube.com/@kingside"
              target="_blank"
              rel="noopener noreferrer"
              className="landing-btn landing-btn--youtube"
            >
              ▶ YouTube канал
            </a>
          </div>
        </section>

        {/* ---------- Блок 6: INLINE-FOOTER ---------- */}
        <footer className="landing-inline-footer">
          <Link to="/terms">Правила использования</Link>
          <span className="landing-inline-footer__sep">·</span>
          <Link to="/help/external-engine">Внешний движок</Link>
          <span className="landing-inline-footer__sep">·</span>
          <Link to="/credits">Открытые ассеты</Link>
        </footer>
      </div>
    </div>
  );
}
