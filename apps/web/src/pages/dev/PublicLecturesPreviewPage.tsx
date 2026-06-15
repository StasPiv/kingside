/**
 * KS-4196 dev-only песочница: рендерит `PublicLecturesCatalog`-разметку
 * со статическими данными для приёмочных скриншотов гостевого `/lectures`.
 * Доступ: `/__dev/public-lectures` (роут добавлен в `App.tsx`).
 *
 * Используется для верификации:
 *  - Hero + guest-CTA баннера;
 *  - табов фильтра (All / Live / Scheduled / Recorded);
 *  - грида карточек на десктопе/мобильном;
 *  - всех вариантов бейджей статусов на карточке;
 *  - preview-режима «Discover public lectures» (компактный блок).
 *
 * Логика API не задействована: рендерим разметку напрямую с фикстурами.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';

type Status = 'live' | 'scheduled' | 'recorded';

interface Fixture {
  id: string;
  title: string;
  description: string;
  status: Status;
  coach: string;
  scheduledLabel?: string;
  duration?: string;
  fen: string;
}

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FIXTURES: Fixture[] = [
  {
    id: '1',
    title: 'Защита Каро-Канн: главные линии',
    description:
      'Разбираем тонкости главных линий за обе стороны: типичные планы белых после короткой рокировки и контригра чёрных по полям d5/c5.',
    status: 'live',
    coach: 'GM_Alekseev',
    fen: 'rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3',
  },
  {
    id: '2',
    title: 'Эндшпиль ладья + пешка против ладьи',
    description:
      'Систематический разбор позиции Лусены и Филидора. Покажу, как удерживать ничью даже в неприятных конфигурациях.',
    status: 'scheduled',
    coach: 'IM_Petrov',
    scheduledLabel: '30 мая, 20:00',
    fen: '8/8/3k4/8/3K4/8/3P4/3R4 w - - 0 1',
  },
  {
    id: '3',
    title: 'Атака на короткую рокировку: модельные партии',
    description:
      'Шесть классических партий с разбором ключевых жертв на h7 и переноса ферзя на линию g.',
    status: 'recorded',
    coach: 'GM_Smirnov',
    duration: '1h 12m',
    fen: 'r1bqr1k1/pp1n1pbp/2p2np1/3p4/2PP4/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 0 9',
  },
  {
    id: '4',
    title: 'Сицилианская защита: вариант Найдорфа',
    description:
      'Современная теория и практические рекомендации для обеих сторон в Английской атаке 6.Be3.',
    status: 'scheduled',
    coach: 'GM_Volkov',
    scheduledLabel: '2 июня, 19:00',
    fen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6',
  },
  {
    id: '5',
    title: 'Ферзевый гамбит: классические варианты',
    description:
      'Базовая структура d4-c4, типичные пешечные конфигурации и план белых с центральным напряжением.',
    status: 'recorded',
    coach: 'FM_Ivanov',
    duration: '54 min',
    fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3',
  },
  {
    id: '6',
    title: 'Тактика: связки и вилки в практической игре',
    description:
      'Подборка из 20 учебных позиций с пошаговым разбором тактических мотивов.',
    status: 'recorded',
    coach: 'WIM_Lebedeva',
    duration: '38 min',
    fen: STARTING_FEN,
  },
];

function statusBadge(status: Status, scheduledLabel?: string): string {
  if (status === 'live') return 'LIVE';
  if (status === 'scheduled')
    return scheduledLabel ? `Scheduled · ${scheduledLabel}` : 'Scheduled';
  return 'Recorded';
}

export default function PublicLecturesPreviewPage() {
  const [statusTab, setStatusTab] = useState<'all' | Status>('all');
  const [showGuestCta, setShowGuestCta] = useState(true);
  const [mode, setMode] = useState<'full' | 'preview' | 'empty' | 'loading' | 'error'>(
    'full',
  );

  const items =
    statusTab === 'all'
      ? FIXTURES
      : FIXTURES.filter((f) => f.status === statusTab);

  const renderCard = (lecture: Fixture) => (
    <article
      key={lecture.id}
      className={`public-lecture-card public-lecture-card--${lecture.status}`}
      data-testid={`public-lecture-card-${lecture.id}`}
    >
      <Link
        to="#"
        className="public-lecture-card__board-link"
        aria-label={lecture.title}
        onClick={(e) => e.preventDefault()}
      >
        <div className="public-lecture-card__board">
          <Chessboard
            options={{
              position: lecture.fen,
              allowDragging: false,
              animationDurationInMs: 0,
              showNotation: false,
            }}
          />
        </div>
        <span
          className={`public-lecture-card__status-badge public-lecture-card__status-badge--${lecture.status}`}
        >
          {statusBadge(lecture.status, lecture.scheduledLabel)}
        </span>
      </Link>

      <div className="public-lecture-card__body">
        <Link
          to="#"
          className="public-lecture-card__title-link"
          onClick={(e) => e.preventDefault()}
        >
          <h3 className="public-lecture-card__title">{lecture.title}</h3>
        </Link>
        <Link
          to="#"
          className="public-lecture-card__coach"
          onClick={(e) => e.preventDefault()}
        >
          {lecture.coach}
        </Link>
        <p className="public-lecture-card__description">{lecture.description}</p>
        {lecture.duration && (
          <div className="public-lecture-card__meta">
            <span className="public-lecture-card__duration">
              {lecture.duration}
            </span>
          </div>
        )}
      </div>
    </article>
  );

  return (
    <div className="lectures-index-page lectures-index-page--public">
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: '0 0 20px',
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 20,
        }}
      >
        <span style={{ fontSize: 12, opacity: 0.7, marginRight: 8 }}>
          KS-4196 preview ·
        </span>
        {(['full', 'preview', 'empty', 'loading', 'error'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-mid)',
              background: mode === m ? 'var(--accent-primary)' : 'transparent',
              color: mode === m ? 'var(--text-on-accent)' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: 12,
              textTransform: 'capitalize',
            }}
          >
            {m}
          </button>
        ))}
        <label
          style={{
            marginLeft: 12,
            fontSize: 12,
            color: 'var(--text-secondary)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <input
            type="checkbox"
            checked={showGuestCta}
            onChange={(e) => setShowGuestCta(e.target.checked)}
          />
          guest CTA
        </label>
      </div>

      {mode === 'error' && (
        <section
          className="public-lectures-catalog public-lectures-catalog--error"
          data-testid="public-lectures-error"
        >
          <p className="public-lectures-catalog__error-text">
            Could not load lectures. Please try again later.
          </p>
          <button type="button" className="public-lectures-catalog__retry">
            Retry
          </button>
        </section>
      )}

      {mode === 'preview' && (
        <section
          className="public-lectures-catalog public-lectures-catalog--preview"
          data-testid="public-lectures-catalog-preview"
        >
          <header className="public-lectures-catalog__preview-header">
            <h2 className="public-lectures-catalog__preview-title">
              Discover public lectures
            </h2>
            <Link
              to="#"
              className="public-lectures-catalog__see-all"
              onClick={(e) => e.preventDefault()}
            >
              See all
            </Link>
          </header>
          <div
            className="public-lectures-catalog__grid"
            data-testid="public-lectures-grid"
          >
            {FIXTURES.slice(0, 3).map(renderCard)}
          </div>
        </section>
      )}

      {(mode === 'full' || mode === 'empty' || mode === 'loading') && (
        <section
          className="public-lectures-catalog public-lectures-catalog--full"
          data-testid="public-lectures-catalog-full"
        >
          <header className="public-lectures-catalog__hero">
            <h1 className="public-lectures-catalog__hero-title">
              Chess lectures and coaches
            </h1>
            <p className="public-lectures-catalog__hero-subtitle">
              Live and recorded chess lectures by titled coaches. Watch openings,
              endgame technique and tactics from grandmasters and international
              masters.
            </p>
          </header>

          {showGuestCta && (
            <div
              className="public-lectures-catalog__guest-cta"
              data-testid="public-lectures-guest-cta"
            >
              <p>Sign in to book lectures and get live access.</p>
              <Link
                to="#"
                className="public-lectures-catalog__guest-cta-link"
                onClick={(e) => e.preventDefault()}
              >
                Sign in
              </Link>
            </div>
          )}

          <nav
            className="public-lectures-catalog__tabs"
            role="tablist"
            aria-label="Filter lectures by status"
          >
            {(['all', 'live', 'scheduled', 'recorded'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={statusTab === tab}
                className={`public-lectures-catalog__tab${statusTab === tab ? ' public-lectures-catalog__tab--active' : ''}`}
                onClick={() => setStatusTab(tab)}
              >
                {tab === 'all'
                  ? 'All'
                  : tab === 'live'
                    ? 'Live'
                    : tab === 'scheduled'
                      ? 'Scheduled'
                      : 'Recorded'}
              </button>
            ))}
          </nav>

          {mode === 'loading' ? (
            <p className="public-lectures-catalog__loading">Loading…</p>
          ) : mode === 'empty' ? (
            <p className="public-lectures-catalog__empty">
              No lectures match the current filter.
            </p>
          ) : (
            <>
              <div
                className="public-lectures-catalog__grid"
                data-testid="public-lectures-grid"
              >
                {items.map(renderCard)}
              </div>
              <div className="public-lectures-catalog__show-more">
                <button
                  type="button"
                  className="public-lectures-catalog__show-more-btn"
                >
                  Show more
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
