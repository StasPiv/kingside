/**
 * KS-3981 dev-only песочница: рендерит `LectureLandingPage`-разметку
 * со статическими данными для приёмочных скриншотов адаптива.
 * Доступ: `/__dev/lecture-landing` (роут добавлен в `App.tsx`).
 *
 * Используется для верификации:
 *  - двухколоночного layout'а на ≥ 768px (контент + meta-aside);
 *  - переноса в одну колонку на узком экране;
 *  - бейджа статуса в шапке и в aside.
 */
import { useState } from 'react';

type Status = 'live' | 'scheduled' | 'recorded';

const FIXTURES: Record<Status, { title: string; description: string; meta: string; slug?: string }> = {
  live: {
    title: 'Защита Каро-Канн: главные линии',
    description:
      'Разбираем тонкости главных линий за обе стороны: типичные планы белых после короткой рокировки и контригра чёрных по полям d5/c5. Лекция идёт в реальном времени, можно задавать вопросы в чате.',
    meta: '24 мая 2026, 19:00',
    slug: 'caro-kann-live-24',
  },
  scheduled: {
    title: 'Эндшпиль ладья + пешка против ладьи',
    description:
      'Систематический разбор позиции Лусены и Филидора. Покажу, как удерживать ничью даже в неприятных конфигурациях и где у защищающейся стороны типичные ловушки.',
    meta: '30 мая 2026, 20:00',
  },
  recorded: {
    title: 'Атака на короткую рокировку: модельные партии',
    description:
      'Подборка из 6 модельных партий гроссмейстеров с детальным разбором ключевых моментов. Длительность записи — 1 час 12 минут.',
    meta: '12 апреля 2026',
    slug: 'kingside-attack-replay',
  },
};

function badgeClass(status: Status): string {
  return `lecture-status-badge lecture-status-badge--${status}`;
}

function badgeText(status: Status): string {
  if (status === 'live') return 'Live';
  if (status === 'scheduled') return 'Scheduled';
  return 'Recorded';
}

export default function LectureLandingPreviewPage() {
  const [status, setStatus] = useState<Status>('scheduled');
  const fx = FIXTURES[status];

  return (
    <div>
      {/* Переключатель статусов — только для песочницы. */}
      <div
        style={{
          maxWidth: 1040,
          margin: '0 auto',
          padding: '16px 20px 0',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 12, opacity: 0.7, marginRight: 8 }}>
          KS-3981 preview ·
        </span>
        {(['live', 'scheduled', 'recorded'] as Status[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            data-testid={`landing-preview-switch-${s}`}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-mid)',
              background: status === s ? 'var(--accent-primary)' : 'transparent',
              color: status === s ? 'var(--text-on-accent)' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: 12,
              textTransform: 'capitalize',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Сама полноразмерная разметка LectureLandingPage. */}
      <div
        className="lecture-landing-page"
        data-testid="lecture-landing-page"
        data-status={status}
      >
        <header className="lecture-landing-page__header">
          <h1 className="lecture-landing-page__title">{fx.title}</h1>
          <span className={badgeClass(status)}>{badgeText(status)}</span>
        </header>

        <main className="lecture-landing-page__main">
          <p className="lecture-landing-page__description">{fx.description}</p>

          {status === 'scheduled' && (
            <div className="lecture-landing-page__cta-block">
              <p className="lecture-landing-page__cta-body">
                Lecture is scheduled to start at: <strong>{fx.meta}</strong>
              </p>
              <button
                type="button"
                disabled
                className="lecture-landing-page__cta lecture-landing-page__cta--disabled"
              >
                Waiting for the lecture to start…
              </button>
            </div>
          )}

          {status === 'live' && (
            <div className="lecture-landing-page__cta-block">
              <p className="lecture-landing-page__cta-body">
                The lecture is live right now.
              </p>
              <a
                href="#"
                onClick={(e) => e.preventDefault()}
                className="lecture-landing-page__cta lecture-landing-page__cta--primary"
              >
                Join broadcast
              </a>
            </div>
          )}

          {status === 'recorded' && (
            <div className="lecture-landing-page__cta-block">
              <p className="lecture-landing-page__cta-body">
                A recording of the lecture is available.
              </p>
              <a
                href="#"
                onClick={(e) => e.preventDefault()}
                className="lecture-landing-page__cta lecture-landing-page__cta--primary"
              >
                Watch recording
              </a>
            </div>
          )}
        </main>

        <aside className="lecture-landing-page__aside">
          <div className="lecture-landing-page__meta-row">
            <span className="lecture-landing-page__meta-label">Status</span>
            <span className="lecture-landing-page__meta-value">
              <span className={badgeClass(status)}>{badgeText(status)}</span>
            </span>
          </div>
          <div className="lecture-landing-page__meta-row">
            <span className="lecture-landing-page__meta-label">
              {status === 'recorded' ? 'Date' : 'Starts at'}
            </span>
            <span className="lecture-landing-page__meta-value">{fx.meta}</span>
          </div>
          {fx.slug && (
            <div className="lecture-landing-page__meta-row">
              <span className="lecture-landing-page__meta-label">
                Broadcast
              </span>
              <span className="lecture-landing-page__meta-value">{fx.slug}</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
