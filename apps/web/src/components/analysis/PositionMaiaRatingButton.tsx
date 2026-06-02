/**
 * KS-3579 / KS-3580. Кнопка «Получить рейтинг позиции» — оценивает, на
 * каком ELO Maia-3 впервые выдаёт тот же лучший ход, что Stockfish.
 *
 * Состояния:
 *  - idle: кнопка «Получить рейтинг позиции», disabled если нет
 *    Stockfish-best-хода (движок не запущен / не нашёл линию).
 *  - computing: «Считаем рейтинг…» (disabled).
 *  - done: «Этот ход на уровне ~<число>» + кнопка «Ещё раз».
 *  - above-range (KS-3580): вместо безразличного «выше диапазона» —
 *    короткая подпись «Maia предпочитает:» и список топ-ходов от 2400
 *    (топ-3 или все с p > 10%, что больше) с SAN-нотацией и %.
 *  - error: дженерик-сообщение об ошибке + кнопка «Ещё раз».
 *
 * Без подписей про шкалу, FIDE, Lichess — только число (KS-3579).
 */
import { useTranslation } from 'react-i18next';

import { usePositionMaiaRating } from '../../hooks/usePositionMaiaRating';
import { uciToSan } from '../../lib/maia/uciToSan';

export interface PositionMaiaRatingButtonProps {
  /** Текущий FEN на доске. */
  fen: string;
  /** Лучший ход Stockfish (UCI, например `e2e4`). `null` пока движок не
   *  даёт линию — кнопка disabled. */
  stockfishBestUci: string | null;
}

function formatProbability(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function PositionMaiaRatingButton({
  fen,
  stockfishBestUci,
}: PositionMaiaRatingButtonProps) {
  const { t } = useTranslation();
  const { status, rating, topMoves, compute, reset } = usePositionMaiaRating();

  const disabled =
    !fen || !stockfishBestUci || status === 'computing';

  const handleClick = () => {
    if (!fen || !stockfishBestUci) return;
    void compute(fen, stockfishBestUci);
  };

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

  // KS-3580: above-range отдельный layout — заголовок + список ходов.
  if (status === 'above-range') {
    return (
      <div
        className="position-maia-rating"
        data-testid="position-maia-rating"
        data-status={status}
      >
        <div className="position-maia-rating__fallback">
          <span
            className="position-maia-rating__fallback-title"
            data-testid="position-maia-rating-fallback-title"
          >
            {t('positionMaiaRating.fallbackTitle', 'Maia предпочитает:')}
          </span>
          <ul
            className="position-maia-rating__fallback-list"
            data-testid="position-maia-rating-fallback-list"
          >
            {topMoves.map((m) => (
              <li
                key={m.move}
                className="position-maia-rating__fallback-item"
                data-testid={`position-maia-rating-fallback-item-${m.move}`}
              >
                <span className="position-maia-rating__fallback-move">
                  {uciToSan(fen, m.move)}
                </span>
                <span className="position-maia-rating__fallback-sep">{' — '}</span>
                <span className="position-maia-rating__fallback-prob">
                  {formatProbability(m.probability)}
                </span>
              </li>
            ))}
          </ul>
        </div>
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

  // done / error — одна строка результата + reset.
  let resultLabel: string | null = null;
  if (status === 'done' && rating != null) {
    resultLabel = t(
      'positionMaiaRating.matched',
      'Этот ход на уровне ~{{rating}}',
      { rating },
    );
  } else if (status === 'error') {
    resultLabel = t(
      'positionMaiaRating.error',
      'Не удалось получить рейтинг',
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
