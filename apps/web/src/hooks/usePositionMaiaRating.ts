/**
 * KS-3579. Хук «получить рейтинг позиции» — на каком ELO Maia-3
 * впервые выдаёт тот же top-1 ход, что и Stockfish.
 *
 * Алгоритм:
 *  1. Берём текущий FEN + лучший ход от Stockfish (UCI).
 *  2. Прогоняем Maia ОДНИМ батчем на 14 рейтингах (1100..2400, шаг 100).
 *  3. Из каждого батча берём top-1 (policy[0]).
 *  4. Возвращаем минимальный рейтинг, на котором Maia top-1 совпал с
 *     `stockfishBestUci`. Если ни на одном — статус `above-range` и
 *     топовая policy от 2400 (см. KS-3580).
 *
 * Контракт компонента/хука:
 *  - `status`: 'idle' → 'computing' → 'done' | 'above-range' | 'error'.
 *  - `rating`: число только при `done`.
 *  - `topMoves`: для UI fallback'а при `above-range` (KS-3580) —
 *    топ-3 ходов Maia на 2400 или все ходы с p > 10%, что больше.
 *  - `error`: текст только при `error` (не для отображения сырым —
 *    компонент покажет дженерик-сообщение, без техдеталей).
 *
 * Engine инжектится — в тесте передаём mock. В прод-режиме хук сам
 * создаёт `MaiaWorkerEngine` лениво и кэширует его на время жизни
 * хука (cleanup в `terminate` при unmount).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import type { MovePrediction, PredictResult } from '../lib/maia/workerEngine';

/** Шкала ELO для прогона. 14 точек, шаг 100. */
export const POSITION_MAIA_RATINGS: readonly number[] = [
  1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300,
  2400,
];

export type PositionMaiaStatus =
  | 'idle'
  | 'computing'
  | 'done'
  | 'above-range'
  | 'error';

export interface PositionMaiaState {
  status: PositionMaiaStatus;
  /** Минимальный ELO с совпадением. Только при `status === 'done'`. */
  rating: number | null;
  /**
   * KS-3580: вероятные ходы Maia на 2400 для fallback'а при
   * `status === 'above-range'`. Топ-3 или все с probability > 10%
   * (что больше), отсортировано по убыванию вероятности. Только при
   * `above-range`, иначе пустой массив.
   */
  topMoves: MovePrediction[];
  /** Техсообщение об ошибке. Для логов, не для UI. */
  error: string | null;
}

/**
 * KS-3580: фильтрация policy в «вероятные ходы» для fallback'а UI:
 * топ-3 или все с p > 10%, что больше. Принимает уже отсортированный
 * массив (наш `MaiaWorkerEngine.postprocessMaia3` сортирует по убыванию).
 */
export function selectFallbackMoves(
  policy: readonly MovePrediction[],
): MovePrediction[] {
  if (policy.length === 0) return [];
  const aboveThreshold = policy.filter((m) => m.probability > 0.1);
  // «Топ-3 или все > 10%, что больше».
  if (aboveThreshold.length >= 3) return aboveThreshold;
  return policy.slice(0, 3);
}

/** Узкий интерфейс engine'а — что нужно хуку. Позволяет
 *  подменить в тесте без поднятия worker'а. */
export interface MaiaBatchEngine {
  predictMovesBatch(
    fen: string,
    eloSelfs: number[],
    eloOppos: number[],
  ): Promise<PredictResult[]>;
  terminate?(): void;
}

export interface UsePositionMaiaRatingOptions {
  /** Кастомный engine (для тестов). По умолчанию — `MaiaWorkerEngine`. */
  engine?: MaiaBatchEngine;
}

export function usePositionMaiaRating(
  options: UsePositionMaiaRatingOptions = {},
) {
  const [state, setState] = useState<PositionMaiaState>({
    status: 'idle',
    rating: null,
    topMoves: [],
    error: null,
  });
  const engineRef = useRef<MaiaBatchEngine | null>(options.engine ?? null);
  const ownsEngineRef = useRef<boolean>(false);
  // KS-3579: гард от устаревших ответов (юзер успел кликнуть на другой
  // позиции, пока считался первый прогон).
  const requestIdRef = useRef(0);

  const compute = useCallback(
    async (fen: string, stockfishBestUci: string): Promise<void> => {
      const requestId = ++requestIdRef.current;
      setState({
        status: 'computing',
        rating: null,
        topMoves: [],
        error: null,
      });

      try {
        if (!engineRef.current) {
          engineRef.current = new MaiaWorkerEngine();
          ownsEngineRef.current = true;
        }

        const ratings = POSITION_MAIA_RATINGS;
        const results = await engineRef.current.predictMovesBatch(
          fen,
          [...ratings],
          [...ratings],
        );

        // Игнорируем результат, если успела начаться следующая операция.
        if (requestId !== requestIdRef.current) return;

        // Логика: первый ELO, на котором top-1 Maia == stockfishBest.
        let matched: number | null = null;
        for (let i = 0; i < ratings.length; i++) {
          const top = results[i]?.policy[0]?.move;
          if (top === stockfishBestUci) {
            matched = ratings[i];
            break;
          }
        }

        if (matched != null) {
          setState({
            status: 'done',
            rating: matched,
            topMoves: [],
            error: null,
          });
        } else {
          // KS-3580: fallback — топовая policy от 2400 (последний батч).
          // Если по какой-то причине результата нет — пустой массив,
          // UI покажет сообщение без списка.
          const topRatingResult = results[results.length - 1];
          const fallbackMoves = topRatingResult
            ? selectFallbackMoves(topRatingResult.policy)
            : [];
          setState({
            status: 'above-range',
            rating: null,
            topMoves: fallbackMoves,
            error: null,
          });
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setState({
          status: 'error',
          rating: null,
          topMoves: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    requestIdRef.current++;
    setState({ status: 'idle', rating: null, topMoves: [], error: null });
  }, []);

  useEffect(() => {
    return () => {
      if (ownsEngineRef.current && engineRef.current?.terminate) {
        engineRef.current.terminate();
      }
    };
  }, []);

  return { ...state, compute, reset };
}
