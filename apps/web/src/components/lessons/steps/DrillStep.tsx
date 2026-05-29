import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DrillStepPayload,
  TacticDrillAttemptRequest,
  TacticDrillAttemptResponse,
  TacticDrillByStepResponse,
  TacticDrillDto,
} from '@kingside/shared';

import { api } from '../../../api';
import { isTacticDrillType } from '../../../utils/tacticDrillTypes';
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
 *   loadDrill   → GET /tactic-drill/by-step/{stepId} (KS-2315)
 *                 → fallback /tactic-drill/next?type=… если stepId
 *                   не задан (например, embedded preview без сохранения)
 *   submitAnswer → POST /tactic-drill/attempt с mode='lessons-embed'
 *
 * Резолвер `/by-step/:stepId` (KS-2315) поддерживает:
 *   • fixed позиция через `payload.drillId`,
 *   • random pool по `payload.drillType` + опц. `difficultyBucket`
 *     (server-side bucket→difficulty mapping через
 *     `DRILL_BUCKET_TO_DIFFICULTY` в shared).
 * Edge-cases резолвера (404 на пустом пуле / удалённый drillId, 400
 * на malformed payload) пробрасываются как loadFailed-state в
 * DrillRunner — пользователь видит retry-кнопку.
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
    // KS-2315 (готов, ea921bc9): резолвер by-step знает payload и сам
    // выбирает fixed/random. Без stepId — fallback на тот же endpoint
    // что у DrillPage (preview-сценарий вне сохранённого шага).
    if (stepId) {
      const resp = await api.get<TacticDrillByStepResponse>(
        `/tactic-drill/by-step/${encodeURIComponent(stepId)}`,
      );
      return resp.drill;
    }
    // KS-3414 (прод-фикс гонки): НЕ слать GET /tactic-drill/next без
    // валидного `type` — backend валидирует type ∈ 7 drill-типов и
    // отдаёт 400 на пустой/неизвестный. Если payload.drillType ещё не
    // проставлен/битый (гонка первой загрузки), бросаем БЕЗ запроса —
    // DrillRunner покажет retry, а когда тип проставится, loadDrill
    // сменит идентичность и mount-эффект перезапустит загрузку.
    if (!isTacticDrillType(payload.drillType)) {
      throw new Error('tactic drill type not ready');
    }
    return api.get<TacticDrillDto>(
      `/tactic-drill/next?type=${encodeURIComponent(payload.drillType)}`,
    );
  }, [stepId, payload.drillType]);

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
