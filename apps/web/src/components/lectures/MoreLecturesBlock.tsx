/**
 * KS-4646 — блок «More lectures» на странице конкретной лекции.
 * Усиливает внутреннюю перелинковку для SEO: с лендинга/replay
 * лекции даёт Googlebot'у 4–6 живых ссылок на другие публичные
 * лекции (`/lectures/<uuid>`). Источник — `GET /lectures/public`,
 * текущая лекция исключается по id.
 *
 * Состояния:
 *  - loading / error / список из 0 элементов → блок не рендерится
 *    (нет смысла показывать пустую секцию). На SEO это не влияет:
 *    у Googlebot prerender дёргает API синхронно и при отсутствии
 *    данных получает пустой блок (что симметрично «нет лекций»).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePublicLectures } from '../../hooks/usePublicLectures';

export interface MoreLecturesBlockProps {
  /** UUID текущей лекции — исключается из результата. */
  excludeId: string;
  /** Сколько карточек показывать (по умолчанию 6). */
  limit?: number;
}

export function MoreLecturesBlock({
  excludeId,
  limit = 6,
}: MoreLecturesBlockProps) {
  const { t } = useTranslation();
  // Запрашиваем чуть больше, чем нужно показать — чтобы после
  // исключения текущей лекции осталось ровно `limit`.
  const state = usePublicLectures({ limit: limit + 1 });

  if (state.loading || state.error) return null;
  const items = state.items.filter((l) => l.id !== excludeId).slice(0, limit);
  if (items.length === 0) return null;

  return (
    <section
      className="more-lectures-block"
      data-testid="more-lectures-block"
      aria-labelledby="more-lectures-heading"
      style={{
        margin: '24px 0 8px',
        padding: '16px 0',
        borderTop: '1px solid var(--border-color, rgba(127,127,127,0.2))',
      }}
    >
      <h2
        id="more-lectures-heading"
        style={{ fontSize: 18, margin: '0 0 12px' }}
      >
        {t('lecturesPublic.moreLecturesTitle', 'More lectures')}
      </h2>
      <ul
        className="more-lectures-block__list"
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        }}
      >
        {items.map((l) => {
          const href = `/lectures/${encodeURIComponent(l.id)}`;
          const coachName = l.coach?.username ?? null;
          return (
            <li
              key={l.id}
              className="more-lectures-block__item"
              data-testid={`more-lectures-item-${l.id}`}
              style={{
                padding: 10,
                border: '1px solid var(--border-color, rgba(127,127,127,0.2))',
                borderRadius: 6,
              }}
            >
              <Link
                to={href}
                className="more-lectures-block__title-link"
                style={{ fontWeight: 600, display: 'block' }}
              >
                {l.title}
              </Link>
              {coachName && (
                <Link
                  to={`/coach/${encodeURIComponent(coachName)}`}
                  className="more-lectures-block__coach"
                  style={{
                    display: 'inline-block',
                    marginTop: 4,
                    fontSize: 13,
                    opacity: 0.8,
                  }}
                >
                  {coachName}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p style={{ margin: '12px 0 0' }}>
        <Link
          to="/lectures"
          className="more-lectures-block__all-link"
          data-testid="more-lectures-all-link"
        >
          {t('lecturesPublic.allLecturesLink', 'All lectures →')}
        </Link>
      </p>
    </section>
  );
}
