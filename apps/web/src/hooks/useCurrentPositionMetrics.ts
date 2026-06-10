/**
 * KS-4033. Хук «позиционные метрики текущей позиции на доске».
 *
 * Заменяет дублирующий график вкладки «Метрики» в правой колонке
 * анализа (он повторял `/analyses/:id/metrics` с полной партией).
 * Новая вкладка показывает столбиками метрики только для той позиции,
 * которая сейчас отображается на доске анализа.
 *
 * Источник данных: тот же `evalTrace(fen)` из `lib/review/stockfishTrace`,
 * что использует расчёт всей партии (`usePositionalTrace`) и
 * `window.__ksPositionalDiff` (debug-обвязка, KS-4017 / KS-4021).
 * Дополнительно к стандартному `VALID_IDS` включаем `PSQT_EXTRA_IDS`
 * — те же id, что показывает отладочная таблица: пользователю важны
 * `psqt_*` и `material`/`imbalance` для полноты картины.
 *
 * Пересчёт: при смене `fen` запускаем новый `evalTrace`. Параллельные
 * запросы серилизуются через `runIdRef` — мы принимаем только результат
 * самого свежего вызова, всё, что застряло позади, тихо отбрасывается
 * (актуально при быстрой перемотке партии).
 *
 * Debounce: задержка `debounceMs` (по умолчанию 200 мс) перед запуском
 * `evalTrace`. Пользователь может зажать «вперёд» — без debounce
 * параллельные `evalTrace` тут же стартуют для каждого ply, WASM-движок
 * упирается в очередь. С debounce запрос отправляется только когда
 * пользователь остановился.
 */
import { useEffect, useRef, useState } from 'react';
import type { PositionalSubterm } from '@kingside/shared';
import { PSQT_EXTRA_IDS, evalTrace } from '../lib/review/stockfishTrace';

export type CurrentPositionMetricsStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export interface CurrentPositionMetricsState {
  status: CurrentPositionMetricsStatus;
  /** Подкомпоненты от Stockfish для текущей позиции. `null` пока нет данных. */
  subterms: PositionalSubterm[] | null;
  /** FEN, для которого посчитан `subterms`. `null` пока нет данных. */
  fenForSubterms: string | null;
  /** Текст ошибки от WASM-движка (для UI). */
  error: string | null;
}

export interface UseCurrentPositionMetricsArgs {
  /** FEN текущей позиции на доске. */
  fen: string | null | undefined;
  /**
   * Если `false` — хук «спит» и не запускает `evalTrace`. Используется,
   * чтобы не запускать расчёт пока пользователь не открыл вкладку
   * «Метрики» (наверху AnalysisPage можно прокинуть, активна ли вкладка).
   */
  enabled?: boolean;
  /**
   * Задержка перед запуском `evalTrace` после смены `fen`. По умолчанию
   * 200 мс — компромисс между «реагирует на перемотку» и «не нагружает
   * WASM при зажатой стрелке».
   */
  debounceMs?: number;
}

export function useCurrentPositionMetrics({
  fen,
  enabled = true,
  debounceMs = 200,
}: UseCurrentPositionMetricsArgs): CurrentPositionMetricsState {
  const [state, setState] = useState<CurrentPositionMetricsState>({
    status: 'idle',
    subterms: null,
    fenForSubterms: null,
    error: null,
  });

  /**
   * Монотонный счётчик запусков. Каждый новый `evalTrace` забирает себе
   * число и сравнивает с актуальным при `await`. Если за время ожидания
   * счётчик вырос (был новый вызов) — результат текущего запуска
   * отбрасываем, в state ничего не пишем.
   */
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !fen) return;

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    setState((prev) => ({
      ...prev,
      status: 'loading',
      error: null,
    }));

    const timer = setTimeout(async () => {
      if (runIdRef.current !== runId) return;
      try {
        const subterms = await evalTrace(fen, {
          extraValidIds: PSQT_EXTRA_IDS,
        });
        if (runIdRef.current !== runId) return;
        setState({
          status: 'ready',
          subterms,
          fenForSubterms: fen,
          error: null,
        });
      } catch (err) {
        if (runIdRef.current !== runId) return;
        setState({
          status: 'error',
          subterms: null,
          fenForSubterms: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [enabled, fen, debounceMs]);

  return state;
}
