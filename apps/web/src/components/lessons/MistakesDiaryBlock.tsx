import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserMistakeAggregate } from '@kingside/shared';

/**
 * Блок «Дневник ошибок» (L-31 / KS-1802).
 *
 * Показывает топ-5 тем из `GET /lessons/mistakes/aggregates`. Пустой
 * список / ошибка запроса — блок скрыт (по тому же паттерну, что
 * `ReviewsDueBlock`).
 *
 * Кнопка «Потренировать» ведёт на `/lessons/mistakes-practice?theme=<...>`,
 * где отдельная страница берёт готовый `PuzzleStepPayload` из
 * `/lessons/mistakes/recommendations` и подставляет в существующий
 * `PuzzleStep` (API L-06).
 *
 * Ссылка «Смотреть всё» ведёт на `/lessons/mistakes` со всеми темами и
 * счётчиками (без обрезки до топ-5).
 */

const TOP_LIMIT = 5;

interface MistakesDiaryBlockProps {
  aggregates: UserMistakeAggregate[];
  totalThemes?: number;
  errored?: boolean;
}

function formatLastOccurred(
  iso: string,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return t('lessons.mistakes.lastOccurredUnknown', 'recently');
    }
    return d.toLocaleDateString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return t('lessons.mistakes.lastOccurredUnknown', 'recently');
  }
}

export function MistakesDiaryBlock({
  aggregates,
  totalThemes,
  errored,
}: MistakesDiaryBlockProps) {
  const { t, i18n } = useTranslation();

  if (errored) return null;
  if (aggregates.length === 0) return null;

  const topFive = aggregates.slice(0, TOP_LIMIT);
  const hasMore = (totalThemes ?? aggregates.length) > topFive.length;

  return (
    <section
      className="mistakes-diary-block"
      data-testid="mistakes-diary-block"
      aria-label={t('lessons.mistakes.title', 'Mistakes diary')}
    >
      <header className="mistakes-diary-block__header">
        <h2 className="mistakes-diary-block__title">
          {t('lessons.mistakes.title', 'Mistakes diary')}
        </h2>
        <span
          className="mistakes-diary-block__total"
          data-testid="mistakes-diary-total"
        >
          {t('lessons.mistakes.totalThemes', {
            count: totalThemes ?? aggregates.length,
            defaultValue: '{{count}} themes',
          })}
        </span>
      </header>

      <ul className="mistakes-diary-block__list">
        {topFive.map((agg) => (
          <li
            key={agg.theme}
            className="mistakes-diary-block__item"
            data-testid={`mistakes-diary-item-${agg.theme}`}
          >
            <div className="mistakes-diary-block__item-text">
              <div className="mistakes-diary-block__theme">
                {t(`puzzleBrowser.themes.${agg.theme}`, agg.theme)}
              </div>
              <div className="mistakes-diary-block__meta">
                <span
                  className="mistakes-diary-block__count"
                  data-testid={`mistakes-diary-count-${agg.theme}`}
                >
                  {t('lessons.mistakes.count', {
                    count: agg.count,
                    defaultValue: '{{count}} mistakes',
                  })}
                </span>
                <span className="mistakes-diary-block__last">
                  {t('lessons.mistakes.lastOccurred', {
                    date: formatLastOccurred(agg.lastOccurredAt, i18n.language, t),
                    defaultValue: 'Last: {{date}}',
                  })}
                </span>
              </div>
            </div>
            <Link
              to={`/lessons/mistakes-practice?theme=${encodeURIComponent(agg.theme)}`}
              className="mistakes-diary-block__cta"
              data-testid={`mistakes-diary-cta-${agg.theme}`}
            >
              {t('lessons.mistakes.train', 'Train')}
            </Link>
          </li>
        ))}
      </ul>

      {hasMore && (
        <footer className="mistakes-diary-block__footer">
          <Link
            to="/lessons/mistakes"
            className="mistakes-diary-block__see-all"
            data-testid="mistakes-diary-see-all"
          >
            {t('lessons.mistakes.seeAll', 'See all')}
          </Link>
        </footer>
      )}
    </section>
  );
}
