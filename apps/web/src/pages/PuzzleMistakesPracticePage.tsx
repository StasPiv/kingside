import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  UserMistakeRecommendation,
  UserMistakeRecommendationsResponse,
} from '@kingside/shared';

import { puzzleMistakesApi } from '../api/puzzleMistakesApi';
import { PuzzleStep } from '../components/lessons/steps/PuzzleStep';

/**
 * Страница `/puzzles/mistakes-practice?theme=<theme>` (KS-1928 /
 * ADR-032 §3). Тренировка по теме из дневника ошибок.
 *
 * Ранее жила на `/lessons/mistakes-practice`; старый маршрут
 * редиректит сюда через `<Navigate replace>` с сохранением query.
 *
 * Берёт готовый `PuzzleStepPayload` (тип `filter`) из
 * `GET /puzzle/mistakes/recommendations` и подставляет в существующий
 * `PuzzleStep` (API L-06 — ничего нового не дублируем).
 *
 * Если в recommendations нет запрошенной темы (не вошла в топ-3 за
 * последние 30 дней) — показываем дружелюбную заглушку «тему тренировать
 * сейчас нечем» + ссылку назад.
 */

export function PuzzleMistakesPracticePage() {
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
    // KS-2497: для legacy `theme=playVsEngine` будет `<Navigate>`
    // ниже — API дёргать не нужно (плюс mock в тестах не настроен,
    // tape падает с TypeError).
    if (!theme || theme === 'playVsEngine') {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    puzzleMistakesApi
      .getRecommendations()
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
        setError(t('puzzle.mistakes.loadError', 'Failed to load mistakes'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [theme, t]);

  // KS-2497 (ADR-046 §5.7): legacy-ссылки
  // `/puzzles/mistakes-practice?theme=playVsEngine` (шумовая тема,
  // отфильтрованная KS-2496) теперь редиректят на новый раздел.
  // `replace` — кнопка «назад» не возвращает сюда.
  if (theme === 'playVsEngine') {
    return <Navigate to="/puzzles/play-vs-engine" replace />;
  }

  if (!theme) {
    return (
      <div
        className="mistakes-practice-page mistakes-practice-page--empty"
        data-testid="mistakes-practice-empty"
      >
        <p>
          {t(
            'puzzle.mistakes.practice.noTheme',
            'Pick a theme from the mistakes diary.',
          )}
        </p>
        <Link to="/puzzles" data-testid="mistakes-practice-back">
          {t('puzzleStats.backToPuzzles', 'Back to Puzzles')}
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
            'puzzle.mistakes.practice.themeNotInRecs',
            'This theme is not in your top problem areas for the last 30 days. Nice!',
          )}
        </p>
        <Link to="/puzzles" data-testid="mistakes-practice-back">
          {t('puzzleStats.backToPuzzles', 'Back to Puzzles')}
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
          to="/puzzles"
          className="mistakes-practice-page__back"
          data-testid="mistakes-practice-back"
        >
          ← {t('puzzleStats.backToPuzzles', 'Back to Puzzles')}
        </Link>
        <h1>
          {t('puzzle.mistakes.practice.title', {
            theme: t(`puzzleBrowser.themes.${recommendation.theme}`, recommendation.theme),
            defaultValue: 'Training: {{theme}}',
          })}
        </h1>
        <p className="mistakes-practice-page__meta">
          {t('puzzle.mistakes.practice.windowInfo', {
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
