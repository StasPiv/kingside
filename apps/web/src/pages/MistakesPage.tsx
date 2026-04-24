import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserMistakeAggregate } from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';

/**
 * Страница `/lessons/mistakes` — полный список тем дневника ошибок (L-31).
 *
 * Отличие от блока на `LessonsPage` — здесь нет ограничения «топ-5»,
 * показываются все темы из `GET /lessons/mistakes/aggregates`, без
 * параметров (limit по умолчанию backend сам ставит).
 *
 * Клик «Потренировать» ведёт на ту же страницу
 * `/lessons/mistakes-practice?theme=<...>`.
 */

export function MistakesPage() {
  const { t, i18n } = useTranslation();
  const [aggregates, setAggregates] = useState<UserMistakeAggregate[]>([]);
  const [totalThemes, setTotalThemes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    lessonsApi
      .getMistakeAggregates()
      .then((res) => {
        if (cancelled) return;
        setAggregates(res.aggregates);
        setTotalThemes(res.totalThemes);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('lessons.mistakes.loadError', 'Failed to load mistakes'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="mistakes-page" data-testid="mistakes-page">
      <header className="mistakes-page__header">
        <Link
          to="/lessons"
          className="mistakes-page__back-link"
          data-testid="mistakes-page-back"
        >
          ← {t('lessons.backToList', 'All courses')}
        </Link>
        <h1>{t('lessons.mistakes.fullTitle', 'All mistakes')}</h1>
        <p className="mistakes-page__subtitle">
          {t(
            'lessons.mistakes.fullSubtitle',
            'Themes you got wrong most often. Train the top ones to close gaps.',
          )}
        </p>
      </header>

      {loading && (
        <div className="loading" data-testid="mistakes-loading">
          {t('common.loading')}
        </div>
      )}

      {error && (
        <div className="error" data-testid="mistakes-error">
          {error}
        </div>
      )}

      {!loading && !error && aggregates.length === 0 && (
        <div className="lessons-empty" data-testid="mistakes-empty">
          {t(
            'lessons.mistakes.emptyFull',
            'No mistakes recorded yet. Keep solving puzzles.',
          )}
        </div>
      )}

      {!loading && !error && aggregates.length > 0 && (
        <>
          <p className="mistakes-page__total" data-testid="mistakes-page-total">
            {t('lessons.mistakes.totalThemes', {
              count: totalThemes,
              defaultValue: '{{count}} themes',
            })}
          </p>
          <table className="mistakes-page__table" data-testid="mistakes-page-table">
            <thead>
              <tr>
                <th>{t('lessons.mistakes.col.theme', 'Theme')}</th>
                <th>{t('lessons.mistakes.col.count', 'Mistakes')}</th>
                <th>{t('lessons.mistakes.col.lastOccurred', 'Last occurred')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {aggregates.map((agg) => (
                <tr
                  key={agg.theme}
                  data-testid={`mistakes-page-row-${agg.theme}`}
                >
                  <td>{t(`puzzleBrowser.themes.${agg.theme}`, agg.theme)}</td>
                  <td>{agg.count}</td>
                  <td>
                    {new Date(agg.lastOccurredAt).toLocaleDateString(
                      i18n.language,
                      { day: '2-digit', month: 'short', year: 'numeric' },
                    )}
                  </td>
                  <td>
                    <Link
                      to={`/lessons/mistakes-practice?theme=${encodeURIComponent(agg.theme)}`}
                      className="mistakes-page__cta"
                      data-testid={`mistakes-page-cta-${agg.theme}`}
                    >
                      {t('lessons.mistakes.train', 'Train')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
