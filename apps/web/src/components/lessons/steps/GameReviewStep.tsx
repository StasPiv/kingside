import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GameReviewStepPayload } from '@kingside/shared';

import { useGameReport } from '../../../hooks/useGameReport';
import { GameReportPanel } from '../../GameReportPanel';
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
 * - `gameId` задан → тянем готовый `GameReport` через `useGameReport`
 *   (`GET /games/:gameId/report`). Если отчёта нет — пользователь сам
 *   нажимает «Проанализировать» (`POST /games/:gameId/analyze`). Путь
 *   wasm-only по ADR-025 §2.8 — backend считает анализ без серверного
 *   stockfish, `useExternalEngine` не задействован.
 *
 * - `pgn` задан → в этой итерации показываем PGN текстом и ссылку в
 *   Мастерскую: для полного разбора нужно сохранить партию как
 *   `Analysis` (там уже есть доска + `ReviewMoveList` + `EvalBar/Graph`).
 *   Полная интеграция этих компонентов внутри урока — отдельная большая
 *   работа (см. комментарий в конце файла), в MVP обходимся ссылкой.
 *


 * - Оба пустые → показываем выбор источника партии:
 *    * «Импорт с Lichess/chess.com» через `ImportExternalModal`;
 *    * либо ссылка в `/workshop/my-games`, если у пользователя партии
 *      уже есть в БД.
 *   После успешного импорта `ImportExternalModal` вызывает `onImported`,
 *   мы закрываем модалку и пользователь может выбрать партию вручную в
 *   Мастерской — в MVP автовыбор не делаем (нужен отдельный запрос к
 *   `/games/my`, это расширение задачи).
 *
 * # KS-2000: чек-лист удалён
 *
 * До KS-2000 под viewer'ом партии рендерился чек-лист «Разбор партии»
 * с тремя hardcoded-вопросами и кнопка «Шаг пройден» disabled до тех
 * пор пока не отмечены все. Это было заложено по умолчанию во ВСЕ
 * шаги — пользователи Pilot-курса такого не заказывали, поведение
 * выглядело как самодеятельность. Чек-лист и его состояние удалены
 * целиком; шаг завершается обычной кнопкой «Далее» через `onStepDone()`.
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

  const {
    report,
    analyzing,
    error: reportError,
    fetchReport,
    analyze,
  } = useGameReport(gameId);

  // Тянем отчёт при монтировании — только если есть gameId.
  useEffect(() => {
    if (gameId) {
      void fetchReport();
    }
  }, [gameId, fetchReport]);

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
          <GameReportPanel
            report={report}
            analyzing={analyzing}
            error={reportError}
            onAnalyze={analyze}
          />
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

      {/* KS-2000: чек-лист удалён. Шаг завершается кнопкой отметки
          прогресса.
          KS-2043/KS-2056: текст кнопки — «Готово» (lessons.markDone).
          Это единственный способ перехода на следующий шаг: кнопка
          вызывает `onStepDone`, который помечает шаг done и
          переключает на следующий. Внешней кнопки «Далее» в навигации
          больше нет. */}
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

// NOTE: полная интеграция `ReviewMoveList` + `EvalBar/EvalGraph` +
// интерактивной доски внутри шага требует выноса AnalysisPage-state в
// переиспользуемый хук (`useAnalysisController`?). В текущем коде это
// state размазан по `AnalysisPage.tsx` (~1200 строк). По L-30 в
// baseline-итерации оставляем deep-link на `/analysis/:gameId` и
// `/workshop` — полный разбор открывается в отдельной странице. Выносить
// hooks из AnalysisPage лучше отдельной задачей (refactor), чтобы не
// тащить 1000+ строк diff'а в рамках L-30.
