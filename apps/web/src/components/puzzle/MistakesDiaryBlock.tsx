import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserMistakeAggregate } from '@kingside/shared';

import { puzzleMistakesApi } from '../../api/puzzleMistakesApi';
import { useAuth } from '../../context/AuthContext';

/**
 * Полный блок «Слабые темы» (KS-1928 / ADR-032 §3).
 *
 * Self-fetching: тянет `/puzzle/mistakes/aggregates` (limit=5) и
 * сам управляет состояниями. Скрывается при пустом списке / ошибке /
 * без auth — соседним блокам на странице это не мешает.
 *
 * Используется на `/puzzles/stats`. Ссылки ведут в puzzle-namespace:
 * - «Тренировать» → `/puzzles/mistakes-practice?theme=<...>`
 * - «Смотреть всё» → `/puzzles/mistakes`
 *
 * Compact-вариант рендерится отдельным `MistakesDiaryHint` (под доской
 * на `/puzzle`).
 */

const TOP_LIMIT = 5;

function formatLastOccurred(
  iso: string,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return t('puzzle.mistakes.lastOccurredUnknown', 'recently');
    }
    return d.toLocaleDateString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return t('puzzle.mistakes.lastOccurredUnknown', 'recently');
  }
}

interface MistakesDiaryBlockProps {
  /** Лимит запроса; по умолчанию топ-5 (как было в /lessons). */
  limit?: number;
}

export function MistakesDiaryBlock({ limit = TOP_LIMIT }: MistakesDiaryBlockProps = {}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [aggregates, setAggregates] = useState<UserMistakeAggregate[] | null>(null);
  const [totalThemes, setTotalThemes] = useState(0);
  const [errored, setErrored] = useState(false);

  // Стабилизируем зависимость по `user.id` — useAuth может возвращать
  // новый объект `user` на каждом ререндере, и dependency-on-object
  // вызывает повторный fetch без причины.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setErrored(false);
    puzzleMistakesApi
      .getAggregates({ limit })
      .then((res) => {
        if (cancelled) return;
        setAggregates(res.aggregates ?? []);
        setTotalThemes(res.totalThemes ?? 0);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, limit]);

  if (!user) return null;
  if (errored) return null;
  if (aggregates === null || aggregates.length === 0) return null;

  // KS-2496 (ADR-046 §5.6): защитный фильтр от шумовой темы
  // `playVsEngine` — пока не применён backfill (KS-2492), она может
  // прилетать в `user_mistakes.themes`. Темой её показывать
  // методически бессмысленно (нет «темы» как таковой — просто
  // признак режима пазла).
  const filtered = aggregates.filter((a) => a.theme !== 'playVsEngine');
  if (filtered.length === 0) return null;
  const topItems = filtered.slice(0, limit);
  const filteredTotal = Math.max(0, (totalThemes ?? aggregates.length) - (aggregates.length - filtered.length));
  const hasMore = filteredTotal > topItems.length;

  return (
    <section
      className="mistakes-diary-block"
      data-testid="mistakes-diary-block"
      aria-label={t('puzzle.mistakes.title', 'Mistakes diary')}
    >
      <header className="mistakes-diary-block__header">
        <h2 className="mistakes-diary-block__title">
          {t('puzzle.mistakes.title', 'Mistakes diary')}
        </h2>
        <span
          className="mistakes-diary-block__total"
          data-testid="mistakes-diary-total"
        >
          {t('puzzle.mistakes.totalThemes', {
            count: totalThemes ?? aggregates.length,
            defaultValue: '{{count}} themes',
          })}
        </span>
      </header>

      <ul className="mistakes-diary-block__list">
        {topItems.map((agg) => (
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
                  {t('puzzle.mistakes.count', {
                    count: agg.count,
                    defaultValue: '{{count}} mistakes',
                  })}
                </span>
                <span className="mistakes-diary-block__last">
                  {t('puzzle.mistakes.lastOccurred', {
                    date: formatLastOccurred(agg.lastOccurredAt, i18n.language, t),
                    defaultValue: 'Last: {{date}}',
                  })}
                </span>
              </div>
            </div>
            <Link
              to={`/puzzles/mistakes-practice?theme=${encodeURIComponent(agg.theme)}`}
              className="mistakes-diary-block__cta"
              data-testid={`mistakes-diary-cta-${agg.theme}`}
            >
              {t('puzzle.mistakes.train', 'Train')}
            </Link>
          </li>
        ))}
      </ul>

      {hasMore && (
        <footer className="mistakes-diary-block__footer">
          <Link
            to="/puzzles/mistakes"
            className="mistakes-diary-block__see-all"
            data-testid="mistakes-diary-see-all"
          >
            {t('puzzle.mistakes.seeAll', 'See all')}
          </Link>
        </footer>
      )}
    </section>
  );
}
