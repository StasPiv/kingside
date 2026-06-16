import { useTranslation } from 'react-i18next';

/**
 * KS-4292 / ADR-134 §6: pre-game placeholder, который рендерится поверх
 * `.board-container`, пока партия в статусе `waiting` (идёт поиск
 * соперника). Появляется не сразу — родитель монтирует компонент
 * через 1.5 с после входа в `waiting`, чтобы не моргать при быстром
 * нахождении соперника.
 *
 * - Полупрозрачный фон поверх доски (CSS-правило в `game.css`
 *   дополнительно затемняет/бледнит саму `.board-container > *`).
 * - Spinner — CSS-анимация (`@keyframes game-waiting-spin`).
 * - Заголовок «Ищем соперника…» (i18n).
 * - Подпись с режимом и контролем времени, если переданы.
 *
 * На desktop ≥900px CSS-правило прячет overlay (`.game-waiting-overlay
 * { display: none }`) — на десктопной странице игры экран ожидания
 * пользователем не задумывался в KS-4292.
 */

export interface GameWaitingOverlayProps {
  /** Например, «Blitz», «Rapid». Опционально. */
  mode?: string;
  /** Например, «5+0», «3+2». Опционально. */
  timeControl?: string;
}

export function GameWaitingOverlay({ mode, timeControl }: GameWaitingOverlayProps) {
  const { t } = useTranslation();
  const subtitleParts = [mode, timeControl].filter(Boolean);
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : null;

  return (
    <div
      className="game-waiting-overlay"
      data-testid="game-waiting-overlay"
      role="status"
      aria-live="polite"
    >
      <div className="game-waiting-overlay__inner">
        <div
          className="game-waiting-overlay__spinner"
          aria-hidden="true"
        />
        <p className="game-waiting-overlay__title">
          {t('game.searchingOpponent', 'Searching for opponent…')}
        </p>
        {subtitle && (
          <p
            className="game-waiting-overlay__subtitle"
            data-testid="game-waiting-overlay-subtitle"
          >
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
