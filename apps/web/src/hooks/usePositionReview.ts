/**
 * KS-4943/4945 (ADR-165). Хук-обёртка оркестратора разбора позиции.
 *
 * Вся рекурсивная логика — в чистом `buildReviewPlan`
 * (`lib/review/positionReview.ts`), полностью покрыта unit-тестами.
 * Хук предоставляет React-обвязку: статус прогона, результат
 * `ReviewPlan`, ошибку, прогресс построения, отмену (AbortSignal) и
 * guard от устаревших запросов.
 *
 * Движки инъектируются через `PositionReviewEngines` — контракт
 * реализует адаптер `lib/review/reviewEnginesAdapter.ts` поверх
 * промис-драйвера `createDefaultEngines` (SF + Maia, UCI_ShowWDL).
 */
import { useCallback, useRef, useState } from 'react';

import {
  buildReviewPlan,
  defaultReviewConfig,
  ReviewAbortError,
  type PositionReviewEngines,
  type ReviewConfig,
  type ReviewPlan,
  type ReviewPlanOp,
} from '../lib/review/positionReview';

export type PositionReviewStatus =
  | 'idle'
  | 'building'
  | 'ready'
  | 'error'
  | 'cancelled';

export interface UsePositionReviewOptions {
  engines: PositionReviewEngines;
  /** Конфиг порогов/лимитов. По умолчанию — `defaultReviewConfig()`. */
  config?: ReviewConfig;
  /**
   * KS-4950: применяется на каждую операцию по мере расчёта (ход сразу
   * ложится на доску). Пауза внутри задаёт темп. Если промис — дожидаемся.
   */
  onOp?: (op: ReviewPlanOp) => void | Promise<void>;
}

export interface UsePositionReviewResult {
  status: PositionReviewStatus;
  plan: ReviewPlan | null;
  error: string | null;
  /** Число раскрытых узлов во время построения (для индикатора расчёта). */
  builtNodes: number;
  /** Построить план разбора для позиции `fen`. */
  run: (fen: string) => Promise<ReviewPlan | null>;
  /** Отменить текущее построение (до записи в дерево). */
  cancel: () => void;
  /** Сбросить состояние к idle. */
  reset: () => void;
}

export function usePositionReview(
  options: UsePositionReviewOptions,
): UsePositionReviewResult {
  const { engines, config } = options;

  const [status, setStatus] = useState<PositionReviewStatus>('idle');
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [builtNodes, setBuiltNodes] = useState(0);

  // Guard от устаревших прогонов (как в useMaiaAnalysis): актуален только
  // последний вызов run — предыдущие результаты игнорируются.
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // onOp через ref — чтобы `run` не пересоздавался на каждый рендер.
  const onOpRef = useRef(options.onOp);
  onOpRef.current = options.onOp;

  const run = useCallback(
    async (fen: string): Promise<ReviewPlan | null> => {
      const runId = ++runIdRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus('building');
      setError(null);
      setBuiltNodes(0);
      try {
        const result = await buildReviewPlan(
          fen,
          engines,
          config ?? defaultReviewConfig(),
          {
            signal: controller.signal,
            onProgress: (nodes) => {
              if (runId === runIdRef.current) setBuiltNodes(nodes);
            },
            onOp: (op) => onOpRef.current?.(op),
          },
        );
        if (runId !== runIdRef.current) return null; // устарел
        setPlan(result);
        setStatus('ready');
        return result;
      } catch (err) {
        if (runId !== runIdRef.current) return null;
        if (err instanceof ReviewAbortError) {
          setStatus('cancelled');
          return null;
        }
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [engines, config],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    setStatus('idle');
    setPlan(null);
    setError(null);
    setBuiltNodes(0);
  }, []);

  return { status, plan, error, builtNodes, run, cancel, reset };
}
