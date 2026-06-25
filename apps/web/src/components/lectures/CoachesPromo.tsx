/**
 * KS-4646 — статичный промо-блок «Meet our coaches» с двумя
 * известными тренерами проекта (`Stanislav` и `Kingside`). Используется:
 *  - на гостевой главной (`FeaturesPage variant='home'`) — короткая
 *    карточка над футером.
 *  - на `/lectures` (LecturesIndexPage) — секция «Coaches» с обложками.
 *
 * Цель — заметная внутренняя перелинковка на `/coach/<handle>`,
 * чтобы Googlebot обходил профили тренеров (см. KS-4644).
 *
 * Список тренеров намеренно жёстко прошит: на этапе SEO-bootstrap
 * у Kingside ровно два публичных тренера. Когда их число вырастет —
 * блок переедет на динамическую выгрузку через отдельный
 * `GET /coaches/public` (вне scope текущей задачи).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface CoachEntry {
  handle: string;
  /** Локализуемое имя/титул, fallback показывается на en. */
  i18nKey: string;
  fallback: string;
  /** Эмодзи-аватар (плейсхолдер, пока нет реальных портретов). */
  emoji: string;
}

const COACHES: CoachEntry[] = [
  {
    handle: 'Stanislav',
    i18nKey: 'coachesPromo.stanislav.label',
    fallback: 'Stanislav — chess coach',
    emoji: '♚',
  },
  {
    handle: 'Kingside',
    i18nKey: 'coachesPromo.kingside.label',
    fallback: 'Kingside — official coach',
    emoji: '♛',
  },
];

export interface CoachesPromoProps {
  /**
   * Вариант рендера:
   *  - `compact` — двухкарточный блок для главной/футера.
   *  - `section` — секция с обложками для /lectures.
   */
  variant?: 'compact' | 'section';
  /** Опциональный data-testid контейнера. */
  testId?: string;
}

export function CoachesPromo({
  variant = 'compact',
  testId,
}: CoachesPromoProps) {
  const { t } = useTranslation();
  const title = t('coachesPromo.title', 'Meet our coaches');
  const subtitle = t(
    'coachesPromo.subtitle',
    'Live and recorded chess lectures by our titled coaches.',
  );

  if (variant === 'section') {
    return (
      <section
        className="coaches-promo coaches-promo--section"
        data-testid={testId ?? 'coaches-promo-section'}
        aria-labelledby="coaches-promo-section-heading"
        style={{ margin: '24px 0' }}
      >
        <h2
          id="coaches-promo-section-heading"
          style={{ fontSize: 22, margin: '0 0 8px' }}
        >
          {title}
        </h2>
        <p style={{ margin: '0 0 16px', opacity: 0.85 }}>{subtitle}</p>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: 14,
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          }}
        >
          {COACHES.map((c) => (
            <li
              key={c.handle}
              className="coaches-promo__item coaches-promo__item--cover"
              data-testid={`coaches-promo-item-${c.handle}`}
              style={{
                border: '1px solid var(--border-color, rgba(127,127,127,0.2))',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <Link
                to={`/coach/${encodeURIComponent(c.handle)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 14,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span
                  className="coaches-promo__avatar"
                  aria-hidden="true"
                  style={{
                    fontSize: 36,
                    lineHeight: 1,
                    width: 56,
                    height: 56,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--bg-muted, rgba(127,127,127,0.1))',
                    borderRadius: '50%',
                  }}
                >
                  {c.emoji}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>
                    {c.handle}
                  </span>
                  <span style={{ fontSize: 13, opacity: 0.8 }}>
                    {t(c.i18nKey, c.fallback)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // compact: для гостевой главной — карточка с двумя ссылками-аватарами.
  return (
    <section
      className="coaches-promo coaches-promo--compact"
      data-testid={testId ?? 'coaches-promo-compact'}
      aria-labelledby="coaches-promo-compact-heading"
      style={{ margin: '24px auto', maxWidth: 720, textAlign: 'center' }}
    >
      <h2
        id="coaches-promo-compact-heading"
        style={{ fontSize: 20, margin: '0 0 6px' }}
      >
        {title}
      </h2>
      <p style={{ margin: '0 0 14px', opacity: 0.85 }}>{subtitle}</p>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 12,
        }}
      >
        {COACHES.map((c) => (
          <Link
            key={c.handle}
            to={`/coach/${encodeURIComponent(c.handle)}`}
            className="coaches-promo__item coaches-promo__item--compact"
            data-testid={`coaches-promo-compact-${c.handle}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              border: '1px solid var(--border-color, rgba(127,127,127,0.2))',
              borderRadius: 999,
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                fontSize: 22,
                lineHeight: 1,
                width: 32,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-muted, rgba(127,127,127,0.1))',
                borderRadius: '50%',
              }}
            >
              {c.emoji}
            </span>
            <span style={{ fontWeight: 600 }}>{c.handle}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
