import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GameReviewStepPayload } from '@kingside/shared';

import { ImportExternalModal } from '../../workshop/ImportExternalModal';
import { InlinePgnViewer } from './InlinePgnViewer';

/**
 * GameReviewStep — шаг «разбор партии» (L-30, KS-1795).
 *
 * # Источники партии
 *
 * Компонент принимает `GameReviewStepPayload { gameId?, pgn? }` — шаг
 * семантически ожидает ровно одно из двух полей (class-validator DTO на
 * backend валидирует XOR). На фронте:
 *
 * - `gameId` задан → ссылка на полный анализ `/analysis/:gameId`
 *   (там доска + ReviewMoveList + EvalBar/Graph). До KS-2434 здесь
 *   рендерился серверный отчёт; KS-2433 удалил соответствующие
 *   endpoint'ы из API, и inline-блок отчёта убрали — остался только
 *   deep-link.
 *
 * - `pgn` задан → встроенный интерактивный viewer (доска + список
 *   ходов + навигация). WASM/Stockfish не используется: разбор в уроке
 *   — только просмотр PGN.
 *
 * - Оба пустые → выбор источника партии: импорт с Lichess/chess.com
 *   через `ImportExternalModal` или ссылка в `/workshop`. После
 *   успешного импорта `ImportExternalModal` вызывает `onImported`,
 *   и пользователь сам выбирает партию в Мастерской.
 *
 * # Завершение
 *
 * Шаг завершается обычной кнопкой «Готово» через `onStepDone()`
 * (см. KS-2000 — ранее был чек-лист, удалён).
 */

interface GameReviewStepProps {
  payload: GameReviewStepPayload;
  /**
   * Колбэк отметки шага пройденным. `LessonPage` пробрасывает сюда
   * `useLessonProgress.markStep(stepId, 'done')` через `StepRenderer`.
   */
  onStepDone?: () => void;
  hideNext?: boolean;
}

export function GameReviewStep({
  payload,
  onStepDone,
  hideNext = false,
}: GameReviewStepProps) {
  const { t } = useTranslation();
  const gameId = payload.gameId ?? undefined;
  const pgn = payload.pgn ?? undefined;

  const [importSource, setImportSource] = useState<'lichess' | 'chesscom' | null>(
    null,
  );
  const [importJustCompleted, setImportJustCompleted] = useState(false);

  const mode: 'empty' | 'pgn' | 'gameId' = gameId
    ? 'gameId'
    : pgn
    ? 'pgn'
    : 'empty';

  return (
    <div
      className="lesson-game-review-step"
      data-testid="lesson-game-review-step"
      data-mode={mode}
    >
      {mode === 'gameId' && (
        <div
          className="lesson-game-review-step__analysis"
          data-testid="lesson-game-review-step-analysis"
        >
          <p className="lesson-game-review-step__deep-link">
            <Link to={`/analysis/${encodeURIComponent(gameId ?? '')}`}>
              {t('lessons.gameReview.openFullAnalysis', 'Open full analysis')}
            </Link>
          </p>
        </div>
      )}

      {mode === 'pgn' && (
        <div
          className="lesson-game-review-step__pgn"
          data-testid="lesson-game-review-step-pgn"
        >
          {/* KS-1999: вместо сырого PGN + ссылки в Мастерскую — встроенный
              интерактивный viewer (доска + список ходов + навигация).
              WASM/Stockfish здесь не нужен: разбор в уроке — только
              просмотр PGN; для глубокого анализа есть отдельная страница
              Analysis (по `gameId`-режиму этого же шага). */}
          <InlinePgnViewer pgn={pgn ?? ''} />
        </div>
      )}

      {mode === 'empty' && (
        <div
          className="lesson-game-review-step__empty"
          data-testid="lesson-game-review-step-empty"
        >
          <p className="lesson-game-review-step__empty-hint">
            {t(
              'lessons.gameReview.emptyHint',
              'Pick a game from your library or import one from Lichess/chess.com.',
            )}
          </p>
          <div className="lesson-game-review-step__empty-actions">
            <button
              type="button"
              data-testid="lesson-game-review-step-import-lichess"
              className="lesson-game-review-step__import-btn"
              onClick={() => setImportSource('lichess')}
            >
              {t('lessons.gameReview.importLichess', 'Import from Lichess')}
            </button>
            <button
              type="button"
              data-testid="lesson-game-review-step-import-chesscom"
              className="lesson-game-review-step__import-btn"
              onClick={() => setImportSource('chesscom')}
            >
              {t('lessons.gameReview.importChesscom', 'Import from chess.com')}
            </button>
            <Link
              to="/workshop"
              className="lesson-game-review-step__library-link"
              data-testid="lesson-game-review-step-library-link"
            >
              {t('lessons.gameReview.openLibrary', 'My games')}
            </Link>
          </div>
          {importJustCompleted && (
            <p
              className="lesson-game-review-step__empty-note"
              data-testid="lesson-game-review-step-import-done"
            >
              {t(
                'lessons.gameReview.importDoneNote',
                'Games imported. Open them in Workshop and return here for the review step.',
              )}
            </p>
          )}
        </div>
      )}

      {!hideNext && (
        <div className="lesson-game-review-step__actions">
          <button
            type="button"
            className="lesson-game-review-step__next"
            data-testid="lesson-game-review-step-next"
            onClick={() => onStepDone?.()}
          >
            {t('lessons.markDone', 'Got it')}
          </button>
        </div>
      )}

      {importSource && (
        <ImportExternalModal
          source={importSource}
          onClose={() => setImportSource(null)}
          onImported={() => {
            setImportJustCompleted(true);
          }}
        />
      )}
    </div>
  );
}
