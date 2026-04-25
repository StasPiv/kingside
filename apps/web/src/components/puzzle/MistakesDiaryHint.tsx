import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserMistakeAggregate } from '@kingside/shared';

import { puzzleMistakesApi } from '../../api/puzzleMistakesApi';
import { useAuth } from '../../context/AuthContext';

/**
 * `MistakesDiaryHint` — компактный вариант блока «Слабые темы»
 * под доской на `/puzzle` (KS-1928 / ADR-032 §5).
 *
 * Отличия от full `MistakesDiaryBlock`:
 *  - 3 топ-темы как chip'ы «pin (12)», «fork (8)», «mateIn1 (5)»;
 *  - заголовок «Слабые темы», без подзаголовка / счётчика тем;
 *  - каждая chip — `<Link>` на `/puzzles/mistakes-practice?theme=<...>`;
 *  - testid: `puzzle-mistakes-hint`.
 *
 * Self-fetching через `puzzleMistakesApi.getAggregates({limit:3})`.
 * Скрыт при `aggregates.length === 0`, без auth, при ошибке fetch'а.
 */

const HINT_LIMIT = 3;

export function MistakesDiaryHint() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [aggregates, setAggregates] = useState<UserMistakeAggregate[] | null>(null);
  const [errored, setErrored] = useState(false);

  // Стабилизируем зависимость по `user.id` — useAuth может возвращать
  // новый объект `user` на каждом ререндере (см. MistakesDiaryBlock).
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setErrored(false);
    puzzleMistakesApi
      .getAggregates({ limit: HINT_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setAggregates(res.aggregates ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!user) return null;
  if (errored) return null;
  if (aggregates === null || aggregates.length === 0) return null;

  return (
    <section
      className="puzzle-mistakes-hint"
      data-testid="puzzle-mistakes-hint"
      aria-label={t('puzzle.mistakes.title', 'Mistakes diary')}
    >
      <h3 className="puzzle-mistakes-hint__title">
        {t('puzzle.mistakes.title', 'Mistakes diary')}
      </h3>
      <ul className="puzzle-mistakes-hint__chips">
        {aggregates.slice(0, HINT_LIMIT).map((agg) => (
          <li
            key={agg.theme}
            className="puzzle-mistakes-hint__chip-item"
          >
            <Link
              to={`/puzzles/mistakes-practice?theme=${encodeURIComponent(agg.theme)}`}
              className="puzzle-mistakes-hint__chip"
              data-testid={`puzzle-mistakes-hint-chip-${agg.theme}`}
            >
              <span className="puzzle-mistakes-hint__chip-theme">
                {t(`puzzleBrowser.themes.${agg.theme}`, agg.theme)}
              </span>
              <span className="puzzle-mistakes-hint__chip-count">
                ({agg.count})
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
