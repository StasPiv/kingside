/**
 * KS-4943 (ADR-165). Хук-обёртка оркестратора разбора позиции.
 *
 * Вся рекурсивная логика — в чистом `buildReviewPlan`
 * (`lib/review/positionReview.ts`), полностью покрыта unit-тестами.
 * Хук лишь предоставляет React-обвязку: статус прогона, результат
 * `ReviewPlan`, ошибку, guard от устаревших запросов и функцию `run`.
 *
 * Движки инъектируются через `PositionReviewEngines` — этот же контракт
 * реализует интеграция KS-4944 поверх worker-обёрток useMaiaAnalysis /
 * useStockfish (перевод их событийной модели в последовательные
 * промис-фазы). Здесь движки — обязательный аргумент, так что хук
 * остаётся чистым и не тянет воркеры в этот слой.
 */
import { useCallback, useRef, useState } from 'react';

import {
  buildReviewPlan,
  defaultReviewConfig,
  type PositionReviewEngines,
  type ReviewConfig,
  type ReviewPlan,
} from '../lib/review/positionReview';

export type PositionReviewStatus = 'idle' | 'building' | 'ready' | 'error';

export interface UsePositionReviewOptions {
  engines: PositionReviewEngines;
  /** Конфиг порогов/лимитов. По умолчанию — `defaultReviewConfig()`. */
  config?: ReviewConfig;
}

export interface UsePositionReviewResult {
  status: PositionReviewStatus;
  plan: ReviewPlan | null;
  error: string | null;
  /** Построить план разбора для позиции `fen`. */
  run: (fen: string) => Promise<ReviewPlan | null>;
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

  // Guard от устаревших прогонов (как в useMaiaAnalysis): актуален только
  // последний вызов run — предыдущие результаты игнорируются.
  const runIdRef = useRef(0);

  const run = useCallback(
    async (fen: string): Promise<ReviewPlan | null> => {
      const runId = ++runIdRef.current;
      setStatus('building');
      setError(null);
      try {
        const result = await buildReviewPlan(
          fen,
          engines,
          config ?? defaultReviewConfig(),
        );
        if (runId !== runIdRef.current) return null; // устарел
        setPlan(result);
        setStatus('ready');
        return result;
      } catch (err) {
        if (runId !== runIdRef.current) return null;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [engines, config],
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setStatus('idle');
    setPlan(null);
    setError(null);
  }, []);

  return { status, plan, error, run, reset };
}
