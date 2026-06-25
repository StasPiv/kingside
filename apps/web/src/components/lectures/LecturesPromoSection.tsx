/**
 * KS-4646 — промо-секция «Chess lectures» для гостевой главной.
 * Подтягивает 3–4 публичные лекции через `GET /lectures/public` и
 * рендерит как сетку карточек со ссылками на `/lectures/<uuid>`.
 *
 * KS-4646 follow-up: на build-time prerender (`apps/web/scripts/
 * prerender.mjs`) `/lectures/public` мокается пустым ответом — без
 * fallback'а на снапшоте `/` отсутствовали SEO-ссылки на лекции.
 * Теперь секция РЕНДЕРИТСЯ ВСЕГДА: при отсутствии данных показывает
 * заголовок, подпись и ссылку «All lectures →» (+ блок с известными
 * тренерами уже ниже через `CoachesPromo`). Googlebot всегда видит
 * минимум один путь в каталог.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePublicLectures } from '../../hooks/usePublicLectures';

export interface LecturesPromoSectionProps {
  /** Сколько карточек показывать (по умолчанию 4). */
  limit?: number;
}

export function LecturesPromoSection({ limit = 4 }: LecturesPromoSectionProps) {
  const { t } = useTranslation();
  const state = usePublicLectures({ limit });

  const items = state.loading || state.error
    ? []
    : state.items.slice(0, limit);

  return (
    <section
      className="lectures-promo-section"
      data-testid="lectures-promo-section"
      aria-labelledby="lectures-promo-heading"
      style={{ margin: '32px auto', maxWidth: 960 }}
    >
      <h2
        id="lectures-promo-heading"
        className="lectures-promo-section__title"
        style={{ fontSize: 24, margin: '0 0 6px', textAlign: 'center' }}
      >
        {t(
          'home.lecturesPromo.title',
          'Chess lectures by titled coaches',
        )}
      </h2>
      <p
        className="lectures-promo-section__subtitle"
        style={{
          textAlign: 'center',
          opacity: 0.85,
          margin: '0 0 18px',
        }}
      >
        {t(
          'home.lecturesPromo.subtitle',
          'Live and recorded lectures: openings, middlegame, endgame.',
        )}
      </p>
      {items.length === 0 && (
        <p
          className="lectures-promo-section__empty"
          data-testid="lectures-promo-empty"
          style={{ textAlign: 'center', opacity: 0.85, margin: '0 0 16px' }}
        >
          {t(
            'home.lecturesPromo.empty',
            'Browse the full lecture catalog.',
          )}
        </p>
      )}
      <ul
        className="lectures-promo-section__grid"
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 14,
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        }}
      >
        {items.map((l) => {
          const href = `/lectures/${encodeURIComponent(l.id)}`;
          const coachName = l.coach?.username ?? null;
          return (
            <li
              key={l.id}
              className="lectures-promo-section__item"
              data-testid={`lectures-promo-item-${l.id}`}
              style={{
                border: '1px solid var(--border-color, rgba(127,127,127,0.2))',
                borderRadius: 8,
                padding: 14,
              }}
            >
              <Link
                to={href}
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: 15,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                {l.title}
              </Link>
              {coachName && (
                <Link
                  to={`/coach/${encodeURIComponent(coachName)}`}
                  style={{
                    display: 'inline-block',
                    marginTop: 6,
                    fontSize: 13,
                    opacity: 0.85,
                  }}
                >
                  {coachName}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p
        className="lectures-promo-section__cta"
        style={{ textAlign: 'center', margin: '16px 0 0' }}
      >
        <Link
          to="/lectures"
          data-testid="lectures-promo-all-link"
        >
          {t('home.lecturesPromo.allLink', 'All lectures →')}
        </Link>
      </p>
    </section>
  );
}
