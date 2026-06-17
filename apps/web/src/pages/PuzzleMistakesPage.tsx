import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserMistakeAggregate } from '@kingside/shared';

import { puzzleMistakesApi } from '../api/puzzleMistakesApi';

/**
 * Страница `/puzzles/mistakes` — полный список тем дневника ошибок
 * (KS-1928 / ADR-032 §3).
 *
 * Ранее жила на `/lessons/mistakes`; маршрут редиректит на новый
 * через `<Navigate replace>` в App.tsx с сохранением query.
 *
 * Отличие от блока на `/puzzles/stats` — здесь нет ограничения
 * «топ-5», показываются все темы из `GET /puzzle/mistakes/aggregates`,
 * без параметров (limit по умолчанию backend сам ставит).
 */

export function PuzzleMistakesPage() {
  const { t, i18n } = useTranslation();
  const [aggregates, setAggregates] = useState<UserMistakeAggregate[]>([]);
  const [totalThemes, setTotalThemes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    puzzleMistakesApi
      .getAggregates()
      .then((res) => {
        if (cancelled) return;
        setAggregates(res.aggregates);
        setTotalThemes(res.totalThemes);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('puzzle.mistakes.loadError', 'Failed to load mistakes'));
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
          to="/puzzles"
          className="mistakes-page__back-link"
          data-testid="mistakes-page-back"
        >
          ← {t('puzzleStats.backToPuzzles', 'Back to Puzzles')}
        </Link>
        <h1>{t('puzzle.mistakes.fullTitle', 'All mistakes')}</h1>
        <p className="mistakes-page__subtitle">
          {t(
            'puzzle.mistakes.fullSubtitle',
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

      {!loading && !error && (() => {
        // KS-2496 (ADR-046 §5.6): защитный фильтр от шумовой темы
        // `playVsEngine` (см. MistakesDiaryBlock).
        const filtered = aggregates.filter((a) => a.theme !== 'playVsEngine');
        const filteredTotal = Math.max(
          0,
          totalThemes - (aggregates.length - filtered.length),
        );
        if (filtered.length === 0) {
          return (
            <div className="lessons-empty" data-testid="mistakes-empty">
              {t(
                'puzzle.mistakes.emptyFull',
                'No mistakes recorded yet. Keep solving puzzles.',
              )}
            </div>
          );
        }
        return (
          <>
            <p className="mistakes-page__total" data-testid="mistakes-page-total">
              {t('puzzle.mistakes.totalThemes', {
                count: filteredTotal,
                defaultValue: '{{count}} themes',
              })}
            </p>
            <table className="mistakes-page__table" data-testid="mistakes-page-table">
              <thead>
                <tr>
                  <th>{t('puzzle.mistakes.col.theme', 'Theme')}</th>
                  <th>{t('puzzle.mistakes.col.count', 'Mistakes')}</th>
                  <th>{t('puzzle.mistakes.col.lastOccurred', 'Last occurred')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((agg) => (
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
                      to={`/puzzles/mistakes-practice?theme=${encodeURIComponent(agg.theme)}`}
                      className="mistakes-page__cta"
                      data-testid={`mistakes-page-cta-${agg.theme}`}
                    >
                      {t('puzzle.mistakes.train', 'Train')}
                    </Link>
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
          </>
        );
      })()}
      {/* KS-4325: SEO-блок отсюда снят. Текст ушёл на отдельный
          публичный лендинг `/puzzles-from-your-games` — этот раздел
          остался закрытым функциональным дневником ошибок. */}
    </div>
  );
}
