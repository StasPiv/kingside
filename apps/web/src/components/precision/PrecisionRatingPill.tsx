/**
 * KS-3350 (ADR-079 §3.5). Pill «Рейтинг: 1487 (±42)» на странице
 * `/precision`. Показывает текущий precision-рейтинг пользователя
 * (Glicko-1) и RD (отклонение).
 *
 * Источник: `GET /precision/me/rating` (`precisionApi.getMyRating`).
 *
 * Поведение:
 *  - Гостям ничего не рендерим (auth-only).
 *  - Пока запрос в loading — рендерим скелетон-pill с прочерком, чтобы
 *    layout не прыгал.
 *  - При ошибке — pill не отображаем (тихий graceful, как у scope-counts).
 *  - Default для нового юзера без попыток (`{rating: 1500, deviation: 350}`)
 *    показываем как есть — это валидный стартовый рейтинг по Glicko-1.
 *
 * Tooltip — i18n строка `precision.ratingPill.tooltip`.
 * data-testid `precision-rating-pill` (+ внутренние testid'ы для value/dev).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../context/AuthContext';
import { precisionApi } from '../../api/precisionApi';
import type { PrecisionRatingDto } from '@kingside/shared';

export function PrecisionRatingPill() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [rating, setRating] = useState<PrecisionRatingDto | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (!user) {
      setRating(null);
      setErrored(false);
      return;
    }
    let cancelled = false;
    precisionApi
      .getMyRating()
      .then((res) => {
        if (cancelled) return;
        setRating(res);
        setErrored(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRating(null);
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Гость / ошибка → не рендерим pill вообще.
  if (!user || errored) return null;

  const tooltip = t(
    'precision.ratingPill.tooltip',
    'Glicko-1 rating, updated after each attempt',
  );

  // Loading: ratingDto ещё не пришёл — пустой pill-скелетон.
  if (rating == null) {
    return (
      <span
        className="precision-rating-pill precision-rating-pill--loading"
        data-testid="precision-rating-pill"
        data-state="loading"
        title={tooltip}
        aria-label={tooltip}
      >
        <span className="precision-rating-pill__label">
          {t('precision.ratingPill.label', 'Rating')}
        </span>
        <span
          className="precision-rating-pill__value"
          data-testid="precision-rating-pill-value"
        >
          —
        </span>
      </span>
    );
  }

  // Округление: Glicko-1 хранит float, на UI показываем как целое.
  const ratingRounded = Math.round(rating.rating);
  const deviationRounded = Math.round(rating.deviation);

  return (
    <span
      className="precision-rating-pill"
      data-testid="precision-rating-pill"
      data-state="ready"
      data-rating={String(ratingRounded)}
      data-deviation={String(deviationRounded)}
      title={tooltip}
      aria-label={t('precision.ratingPill.aria', {
        defaultValue: 'Precision rating {{rating}} ± {{deviation}}',
        rating: ratingRounded,
        deviation: deviationRounded,
      })}
    >
      <span className="precision-rating-pill__label">
        {t('precision.ratingPill.label', 'Rating')}
      </span>
      <span
        className="precision-rating-pill__value"
        data-testid="precision-rating-pill-value"
      >
        {ratingRounded}
      </span>
      <span
        className="precision-rating-pill__deviation"
        data-testid="precision-rating-pill-deviation"
      >
        (±{deviationRounded})
      </span>
    </span>
  );
}
