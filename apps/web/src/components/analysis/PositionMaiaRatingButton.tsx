/**
 * KS-3579. Кнопка «Получить рейтинг позиции» — оценивает, на каком
 * ELO Maia-3 впервые выдаёт тот же лучший ход, что Stockfish.
 *
 * Состояния:
 *  - idle: кнопка «Получить рейтинг позиции», disabled если нет
 *    Stockfish-best-хода (движок не запущен / не нашёл линию).
 *  - computing: «Считаем рейтинг…» (disabled).
 *  - done: «Этот ход на уровне ~<число>» + кнопка «Ещё раз».
 *  - above-range: «Выше диапазона Maia» + кнопка «Ещё раз».
 *  - error: дженерик-сообщение об ошибке + кнопка «Ещё раз».
 *
 * Без подписей про шкалу, FIDE, Lichess — только число (см. acceptance
 * KS-3579).
 */
import { useTranslation } from 'react-i18next';

import { usePositionMaiaRating } from '../../hooks/usePositionMaiaRating';

export interface PositionMaiaRatingButtonProps {
  /** Текущий FEN на доске. */
  fen: string;
  /** Лучший ход Stockfish (UCI, например `e2e4`). `null` пока движок не
   *  даёт линию — кнопка disabled. */
  stockfishBestUci: string | null;
}

export function PositionMaiaRatingButton({
  fen,
  stockfishBestUci,
}: PositionMaiaRatingButtonProps) {
  const { t } = useTranslation();
  const { status, rating, compute, reset } = usePositionMaiaRating();

  const disabled =
    !fen || !stockfishBestUci || status === 'computing';

  const handleClick = () => {
    if (!fen || !stockfishBestUci) return;
    void compute(fen, stockfishBestUci);
  };

  // Сообщение результата — только число при done, дженерик при above/error.
  let resultLabel: string | null = null;
  if (status === 'done' && rating != null) {
    resultLabel = t('positionMaiaRating.matched', 'Этот ход на уровне ~{{rating}}', {
      rating,
    });
  } else if (status === 'above-range') {
    resultLabel = t(
      'positionMaiaRating.aboveRange',
      'Выше диапазона Maia',
    );
  } else if (status === 'error') {
    resultLabel = t(
      'positionMaiaRating.error',
      'Не удалось получить рейтинг',
    );
  }

  if (status === 'idle' || status === 'computing') {
    return (
      <div
        className="position-maia-rating"
        data-testid="position-maia-rating"
        data-status={status}
      >
        <button
          type="button"
          className="position-maia-rating__btn"
          data-testid="position-maia-rating-btn"
          onClick={handleClick}
          disabled={disabled}
        >
          {status === 'computing'
            ? t('positionMaiaRating.loading', 'Считаем рейтинг…')
            : t('positionMaiaRating.cta', 'Получить рейтинг позиции')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="position-maia-rating"
      data-testid="position-maia-rating"
      data-status={status}
    >
      <span
        className="position-maia-rating__result"
        data-testid="position-maia-rating-result"
      >
        {resultLabel}
      </span>
      <button
        type="button"
        className="position-maia-rating__btn position-maia-rating__btn--reset"
        data-testid="position-maia-rating-reset"
        onClick={() => {
          reset();
        }}
      >
        {t('positionMaiaRating.reset', 'Ещё раз')}
      </button>
    </div>
  );
}
