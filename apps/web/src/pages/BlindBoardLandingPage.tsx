/**
 * KS-3442 (ADR-088 §11 F1). Точка входа режима «слепая доска».
 *
 * Маршрут `/blind-board`. Setup-экран с описанием механики и кнопкой
 * «Начать» → монтируем `<BlindBoardSessionRunner>` (он сам делает
 * POST /blind-board/sessions). Выход обратно на setup-экран — через
 * проп `onExit` (кнопка «Играть ещё» в финале / «Назад» в ошибке).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BlindBoardSessionRunner } from '../components/blindBoard/BlindBoardSessionRunner';

export function BlindBoardLandingPage() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('blindBoard.setup.title', 'Blind board')} — Kingside`;
    return () => {
      document.title = prev;
    };
  }, [t]);

  const handleStart = useCallback(() => setRunning(true), []);
  const handleExit = useCallback(() => setRunning(false), []);

  if (running) {
    return (
      <div
        className="blind-board-page"
        data-testid="blind-board-page"
        data-state="playing"
      >
        <div className="blind-board-page__header">
          <button
            type="button"
            className="blind-board-page__back"
            data-testid="blind-board-page-back"
            onClick={handleExit}
          >
            ← {t('blindBoard.setup.back', 'New game')}
          </button>
        </div>
        <BlindBoardSessionRunner onExit={handleExit} />
      </div>
    );
  }

  return (
    <div
      className="blind-board-page"
      data-testid="blind-board-page"
      data-state="setup"
    >
      <h1 data-testid="blind-board-page-title">
        {t('blindBoard.setup.title', 'Blind board')}
      </h1>
      <p className="blind-board-page__intro">
        {t(
          'blindBoard.setup.intro',
          'Memorize the position from the computer move arrows alone — no pieces are shown. After each computer move tap the square of the moved piece and pick its type. Wrong answer ends the session.',
        )}
      </p>
      <button
        type="button"
        className="blind-board-page__start"
        data-testid="blind-board-start"
        onClick={handleStart}
      >
        {t('blindBoard.setup.start', 'Start')}
      </button>
    </div>
  );
}
