import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DrillStepPayload,
  TacticDrillAttemptRequest,
  TacticDrillAttemptResponse,
  TacticDrillDto,
} from '@kingside/shared';

import { api } from '../../../api';
import {
  DrillRunner,
  type DrillRunnerCompletion,
  type DrillRunnerSubmitInput,
} from '../../drills';

/**
 * KS-2249 (ADR-035 §11, Drills E6) — рендер LessonStep с
 * `payload.type='drill'` в lesson player.
 *
 * Использует переиспользуемый `<DrillRunner>` (KS-2249 extract из
 * KS-2233 DrillPage). Привязка к API:
 *
 *   loadDrill   → GET /tactic-drill/next?type={drillType}      (fallback)
 *                 → GET /tactic-drill/by-step/{stepId}          (KS-2315, в работе)
 *   submitAnswer → POST /tactic-drill/attempt с mode='lessons-embed'
 *
 * **TODO (KS-2315)**: после готовности backend-резолвера переключить
 * `loadDrill` на `/tactic-drill/by-step/${stepId}` — это даст:
 *   • поддержку `payload.drillId` (fixed позиция),
 *   • поддержку `difficultyBucket` (random pool),
 *   • серверный bucket→difficulty mapping.
 *
 * Текущий fallback отдаёт случайный drill заданного `drillType` —
 * семантически близко к random-режиму без bucket-фильтра.
 *
 * # Логика count/minSolved
 *
 * - `count` (default 1) — сколько drill'ов подряд решает юзер.
 * - `minSolved` (default = count) — порог зачёта шага.
 * - `<DrillRunner onComplete>` отдаёт `{solved, attempted, success}`.
 *   При `success=true` → `onStepDone()` (lesson player перейдёт к
 *   следующему шагу). При `success=false` — DrillRunner сам показывает
 *   retry-кнопку (KS-2249).
 *
 * # Контракт DOM
 *
 *   <div class="drill-step" data-testid="drill-step"
 *        data-drill-type="<id>" data-step-id="<stepId|''>">
 *     <DrillRunner data-testid="drill-runner" … />
 *   </div>
 */

export interface DrillStepProps {
  payload: DrillStepPayload;
  onStepDone?: () => void;
  /**
   * Опц. id LessonStep'а — нужен для будущего by-step резолвера
   * (KS-2315). Сейчас используется только для data-атрибута.
   */
  stepId?: string;
  /** Скрыть кнопку «Continue» (последний шаг). */
  hideNext?: boolean;
}

export function DrillStep({ payload, onStepDone, stepId, hideNext }: DrillStepProps) {
  const { t } = useTranslation();
  const count = payload.count ?? 1;
  const minSolved = payload.minSolved ?? count;

  const loadDrill = useCallback(async (): Promise<TacticDrillDto> => {
    // KS-2315 (backend, в работе): после релиза резолвера переключить
    // на `/tactic-drill/by-step/${stepId}`. До этого — random pick по
    // `drillType` через тот же endpoint, что использует DrillPage.
    return api.get<TacticDrillDto>(
      `/tactic-drill/next?type=${encodeURIComponent(payload.drillType)}`,
    );
  }, [payload.drillType]);

  const submitAnswer = useCallback(
    async (input: DrillRunnerSubmitInput): Promise<TacticDrillAttemptResponse> => {
      const req: TacticDrillAttemptRequest = {
        drillId: input.drillId,
        userAnswer: input.userAnswer,
        timeMs: input.timeMs,
        // KS-2249: помечаем попытки как 'lessons-embed' — backend
        // (KS-2316/KS-2311) использует mode для разделения статистики
        // standalone-drill vs lesson-context.
        mode: 'lessons-embed',
      };
      return api.post<TacticDrillAttemptResponse>(
        '/tactic-drill/attempt',
        req,
      );
    },
    [],
  );

  const handleComplete = useCallback(
    (result: DrillRunnerCompletion) => {
      if (result.success) {
        onStepDone?.();
      }
      // success=false → DrillRunner сам показывает retry-кнопку.
      // Если нужно поведение «всё равно идти дальше» — host передаёт
      // hideNext=false и юзер попадёт на retry-цикл; lesson-progress
      // не двинется до success.
    },
    [onStepDone],
  );

  return (
    <div
      className="drill-step"
      data-testid="drill-step"
      data-drill-type={payload.drillType}
      data-step-id={stepId ?? ''}
      data-count={count}
      data-min-solved={minSolved}
    >
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        count={count}
        minSolved={minSolved}
        onComplete={handleComplete}
        continueLabel={
          hideNext
            ? t('lessons.complete', 'Complete')
            : t('lessons.next', 'Next')
        }
        contextLabel={
          count > 1 ? t('drills.lesson.contextLabel', 'Drill') : undefined
        }
      />
    </div>
  );
}
