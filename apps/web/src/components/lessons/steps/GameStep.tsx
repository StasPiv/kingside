import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameStepPayload, LessonStepState } from '@kingside/shared';

import { AnalysisPage } from '../../../pages/AnalysisPage';
import { useFocusMode } from '../../../context/FocusModeContext';

/**
 * KS-3182 (ADR-072 §7 F2): шаг «Партия» — read-only просмотр PGN внутри
 * урока. Внутри рендерит `<AnalysisPage embedded embeddedPgn>` — это
 * даёт ученику ту же доску, дерево вариантов, opening explorer и
 * Stockfish, но без owner-actions (Share/Edit/Export). См. описание
 * embedded-режима в `AnalysisPage`.
 *
 * Снизу — единственная CTA «Я разобрал партию» (`onStepDone()`). LessonPage
 * пробрасывает в `onStepDone` `useUserLessonProgress.markStep(stepId,
 * 'done')`, который шлёт `POST /api/lessons/progress/step { state:
 * 'done' }`. Авто-«open=done» не делаем — фиксируем явное действие
 * ученика (он сам сообщает, что просмотрел партию).
 *
 * Источники PGN:
 *  - `sourceType='pgn'` — payload.pgn заполнен автором (chess.js
 *    валидация в редакторе KS-3181, бэкенд KS-3180);
 *  - `sourceType='workshop_analysis'` — backend сделал snapshot из
 *    `Analysis` (см. KS-3180), `payload.pgn` уже заполнен в БД.
 * В обоих случаях здесь читаем `payload.pgn` напрямую — нам не важно,
 * откуда он пришёл. Если поле пустое (теоретически невозможно после
 * валидации в KS-3180), показываем плашку «партия пуста».
 */

interface GameStepProps {
  payload: GameStepPayload;
  /**
   * Колбэк отметки шага пройденным. LessonPage пробрасывает сюда
   * `useUserLessonProgress.markStep(stepId, 'done')` — это и есть
   * `POST /api/lessons/progress/step { state: 'done' }`.
   */
  onStepDone?: () => void;
  /** Скрыть CTA «Я разобрал партию» (preview-режим). */
  hideNext?: boolean;
  /**
   * Состояние шага из агрегата прогресса. Если `done`, CTA рендерится
   * как «Пройдено ✓» (disabled).
   */
  stepState?: LessonStepState;
}

export function GameStep({
  payload,
  onStepDone,
  hideNext = false,
  stepState,
}: GameStepProps) {
  const { t } = useTranslation();
  const pgn = (payload.pgn ?? '').trim();
  // Локальный confirmed-флаг для случая, когда у LessonPage ещё не
  // успело обновиться stepState (оптимистичный апдейт UI до round-trip
  // на backend).
  const [confirmed, setConfirmed] = useState(false);
  const isDone = stepState === 'done' || confirmed;

  /**
   * KS-3188 (ADR-073 §7 F1): на mobile-экранах шаг «Партия» съедает почти
   * весь viewport (доска + tree/explorer/SF внутри embedded AnalysisPage).
   * Активируем focus-mode на время монтирования компонента — CSS
   * скрывает MobileBottomBar и переключает header в compact-вариант.
   * Логика viewport (<768px) полностью в CSS через `@media`; в JS
   * `enable()` вызываем всегда, чтобы не зависеть от `matchMedia` в
   * jsdom-тестах и от race condition'ов resize. `hideNext` (preview-
   * режим в редакторе шага) — НЕ активируем focus, иначе автор курса в
   * выпадающем preview увидит compact-layout вместо обычного редактора.
   */
  const { enable: enableFocusMode, disable: disableFocusMode } = useFocusMode();
  useEffect(() => {
    if (hideNext) return undefined;
    enableFocusMode();
    return () => disableFocusMode();
  }, [hideNext, enableFocusMode, disableFocusMode]);

  if (!pgn) {
    return (
      <div
        className="lesson-game-step lesson-game-step--empty"
        data-testid="lesson-game-step-empty"
      >
        <p>
          {t(
            'lessons.game.emptyPgn',
            'This game step has no PGN attached. Ask the author to fix it.',
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="lesson-game-step" data-testid="lesson-game-step">
      <div
        className="lesson-game-step__viewer"
        data-testid="lesson-game-step-viewer"
      >
        <AnalysisPage embedded embeddedPgn={pgn} />
      </div>

      {!hideNext && (
        <div className="lesson-game-step__actions">
          <button
            type="button"
            className="lesson-game-step__done"
            data-testid="lesson-game-step-done"
            disabled={isDone}
            onClick={() => {
              if (isDone) return;
              setConfirmed(true);
              onStepDone?.();
            }}
          >
            {isDone
              ? t('lessons.game.doneConfirmed', 'Marked as reviewed ✓')
              : t('lessons.game.markDone', "I've reviewed the game")}
          </button>
        </div>
      )}
    </div>
  );
}
