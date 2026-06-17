import { useTranslation } from 'react-i18next';

/**
 * KS-2185 (ADR-034-v2 §10.4 / §6.6).
 *
 * Показывается, когда сервер прислал событие
 * `MatchmakingEvents.NO_OPPONENTS` — пара не нашлась за
 * `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS`. Сервер уже сделал LEAVE сам,
 * поэтому компонент только визуальный — действия inline-кнопок передаёт
 * родитель.
 *
 * Локальный Stockfish-WASM в этом сценарии НЕ активируется (бот через
 * matchmaking приходит как полноценная партия с `isBot=true`, KS-4310).
 */
type NoOpponentsBlockProps = {
  onRetry: () => void;
  onChangeTc: () => void;
  className?: string;
};

export function NoOpponentsBlock({ onRetry, onChangeTc, className }: NoOpponentsBlockProps) {
  const { t } = useTranslation();
  const blockClass = className ? `no-opponents-block ${className}` : 'no-opponents-block';
  return (
    <div className={blockClass} role="status" data-testid="no-opponents-block">
      <h3 className="no-opponents-block__title">{t('matchmaking.noOpponents.title')}</h3>
      <p className="no-opponents-block__subtitle">{t('matchmaking.noOpponents.subtitle')}</p>
      <div className="no-opponents-block__actions">
        <button
          type="button"
          className="play-btn no-opponents-block__btn"
          onClick={onRetry}
          data-testid="no-opponents-retry"
        >
          {t('matchmaking.noOpponents.retry')}
        </button>
        <button
          type="button"
          className="play-btn play-btn--secondary no-opponents-block__btn"
          onClick={onChangeTc}
          data-testid="no-opponents-change-tc"
        >
          {t('matchmaking.noOpponents.changeTc')}
        </button>
      </div>
    </div>
  );
}
