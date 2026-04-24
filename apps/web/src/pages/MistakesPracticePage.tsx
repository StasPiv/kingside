import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  UserMistakeRecommendation,
  UserMistakeRecommendationsResponse,
} from '@kingside/shared';

import { lessonsApi } from '../api/lessonsApi';
import { PuzzleStep } from '../components/lessons/steps/PuzzleStep';

/**
 * Страница `/lessons/mistakes-practice?theme=<theme>` (L-31 / KS-1802).
 *
 * Тренировка по теме из дневника ошибок. Берёт готовый
 * `PuzzleStepPayload` (тип `filter`) из
 * `GET /lessons/mistakes/recommendations` и подставляет в существующий
 * `PuzzleStep` (API L-06 — ничего нового не дублируем).
 *
 * Если в recommendations нет запрошенной темы (не вошла в топ-3 за
 * последние 30 дней) — показываем дружелюбную заглушку «тему тренировать
 * сейчас нечем» + ссылку назад.
 */

export function MistakesPracticePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const theme = searchParams.get('theme') ?? '';

  const [recommendation, setRecommendation] =
    useState<UserMistakeRecommendation | null>(null);
  const [responseMeta, setResponseMeta] = useState<
    Pick<UserMistakeRecommendationsResponse, 'windowDays' | 'ratingPuzzle' | 'ratingRange'> | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!theme) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    lessonsApi
      .getMistakeRecommendations()
      .then((res) => {
        if (cancelled) return;
        const match = res.recommendations.find((r) => r.theme === theme) ?? null;
        setRecommendation(match);
        setResponseMeta({
          windowDays: res.windowDays,
          ratingPuzzle: res.ratingPuzzle,
          ratingRange: res.ratingRange,
        });
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
  }, [theme, t]);

  if (!theme) {
    return (
      <div
        className="mistakes-practice-page mistakes-practice-page--empty"
        data-testid="mistakes-practice-empty"
      >
        <p>
          {t(
            'lessons.mistakes.practice.noTheme',
            'Pick a theme from the mistakes diary.',
          )}
        </p>
        <Link to="/lessons" data-testid="mistakes-practice-back">
          {t('lessons.backToList', 'All courses')}
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="loading" data-testid="mistakes-practice-loading">
        {t('common.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="error" data-testid="mistakes-practice-error">
        {error}
      </div>
    );
  }

  if (!recommendation) {
    return (
      <div
        className="mistakes-practice-page mistakes-practice-page--not-found"
        data-testid="mistakes-practice-not-found"
      >
        <h1>{t(`puzzleBrowser.themes.${theme}`, theme)}</h1>
        <p>
          {t(
            'lessons.mistakes.practice.themeNotInRecs',
            'This theme is not in your top problem areas for the last 30 days. Nice!',
          )}
        </p>
        <Link to="/lessons" data-testid="mistakes-practice-back">
          {t('lessons.backToList', 'All courses')}
        </Link>
      </div>
    );
  }

  return (
    <div
      className="mistakes-practice-page"
      data-testid="mistakes-practice-page"
      data-theme={recommendation.theme}
    >
      <header className="mistakes-practice-page__header">
        <Link
          to="/lessons"
          className="mistakes-practice-page__back"
          data-testid="mistakes-practice-back"
        >
          ← {t('lessons.backToList', 'All courses')}
        </Link>
        <h1>
          {t('lessons.mistakes.practice.title', {
            theme: t(`puzzleBrowser.themes.${recommendation.theme}`, recommendation.theme),
            defaultValue: 'Training: {{theme}}',
          })}
        </h1>
        <p className="mistakes-practice-page__meta">
          {t('lessons.mistakes.practice.windowInfo', {
            count: recommendation.mistakeCount,
            windowDays: responseMeta?.windowDays ?? 30,
            defaultValue:
              '{{count}} mistakes over last {{windowDays}} days',
          })}
        </p>
      </header>

      <PuzzleStep payload={recommendation.puzzleStep} />
    </div>
  );
}
