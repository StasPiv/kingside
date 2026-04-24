import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GameReviewStepPayload } from '@kingside/shared';

import { useGameReport } from '../../../hooks/useGameReport';
import { GameReportPanel } from '../../GameReportPanel';
import { ImportExternalModal } from '../../workshop/ImportExternalModal';

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
 * # Чек-лист «направляющих вопросов»
 *
 * Минимальный набор из roadmap L-30:
 *   1. «Где была ключевая ошибка?»
 *   2. «Какой план был у противника?»
 *   3. «Какой ход был лучшим?»
 *
 * Все пункты обязательны. Пока не отмечены все — кнопка «Шаг пройден»
 * заблокирована. По клику — `onStepDone()`.
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

interface ChecklistItem {
  id: string;
  labelKey: string;
  defaultLabel: string;
}

const CHECKLIST: readonly ChecklistItem[] = [
  {
    id: 'key-mistake',
    labelKey: 'lessons.gameReview.checklist.keyMistake',
    defaultLabel: 'Where was the key mistake?',
  },
  {
    id: 'opponent-plan',
    labelKey: 'lessons.gameReview.checklist.opponentPlan',
    defaultLabel: "What was the opponent's plan?",
  },
  {
    id: 'best-move',
    labelKey: 'lessons.gameReview.checklist.bestMove',
    defaultLabel: 'What was the best move?',
  },
] as const;

export function GameReviewStep({
  payload,
  onStepDone,
  hideNext = false,
}: GameReviewStepProps) {
  const { t } = useTranslation();
  const gameId = payload.gameId ?? undefined;
  const pgn = payload.pgn ?? undefined;

  const [checked, setChecked] = useState<Set<string>>(() => new Set());
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

  const allChecked = useMemo(
    () => CHECKLIST.every((item) => checked.has(item.id)),
    [checked],
  );

  const mode: 'empty' | 'pgn' | 'gameId' = gameId
    ? 'gameId'
    : pgn
    ? 'pgn'
    : 'empty';

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
          <p className="lesson-game-review-step__pgn-hint">
            {t(
              'lessons.gameReview.pgnHint',
              'This step uses an embedded PGN. Save it in the Workshop to run a full WASM analysis.',
            )}
          </p>
          <pre
            className="lesson-game-review-step__pgn-text"
            data-testid="lesson-game-review-step-pgn-text"
          >
            {pgn}
          </pre>
          <p className="lesson-game-review-step__deep-link">
            <Link
              to={`/workshop?importPgn=${encodeURIComponent(pgn ?? '')}`}
              data-testid="lesson-game-review-step-workshop-link"
            >
              {t('lessons.gameReview.openWorkshop', 'Open in Workshop')}
            </Link>
          </p>
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

      <div className="lesson-game-review-step__checklist">
        <h3 className="lesson-game-review-step__checklist-title">
          {t(
            'lessons.gameReview.checklistTitle',
            'Reflect on the game',
          )}
        </h3>
        <ul
          className="lesson-game-review-step__checklist-items"
          data-testid="lesson-game-review-step-checklist"
        >
          {CHECKLIST.map((item) => {
            const isChecked = checked.has(item.id);
            return (
              <li key={item.id} className="lesson-game-review-step__checklist-item">
                <label>
                  <input
                    type="checkbox"
                    data-testid={`lesson-game-review-step-check-${item.id}`}
                    checked={isChecked}
                    onChange={() => toggle(item.id)}
                  />
                  <span>{t(item.labelKey, item.defaultLabel)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      {!hideNext && (
        <div className="lesson-game-review-step__actions">
          <button
            type="button"
            className="lesson-game-review-step__done"
            data-testid="lesson-game-review-step-done"
            onClick={() => onStepDone?.()}
            disabled={!allChecked}
          >
            {t('lessons.gameReview.markDone', 'Step done')}
          </button>
          {!allChecked && (
            <span
              className="lesson-game-review-step__done-hint"
              data-testid="lesson-game-review-step-done-hint"
            >
              {t(
                'lessons.gameReview.needAllChecks',
                'Answer all questions to finish this step',
              )}
            </span>
          )}
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
