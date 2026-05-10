import { useCallback, useEffect, useRef, useState } from 'react';
import { WasmEngineAdapter } from '../utils/engineAdapter';

/**
 * KS-2708. Очередь анализа позиций для broadcast-страниц. Один shared
 * WASM Stockfish, FIFO с replace-by-key (актуальна только последняя
 * позиция партии). Используется `BroadcastRoundPage` для отрисовки
 * eval-bar на каждой мини-доске.
 *
 * Ключевая идея: при `broadcast:move` мы получаем десятки ходов
 * подряд от разных партий — если для каждого пускать analyze(), worker
 * захлебнётся. Поэтому очередь — это `Map<gameKey, fen>`: новый
 * `enqueue(gameKey, fen)` заменяет ранее запланированную позицию той
 * же партии. Worker последовательно достаёт по одной позиции, гонит
 * analyze(depth=10), пишет результат в state.
 *
 * `state.evals` — `Record<gameKey, EvalSnapshot>`. Подписчик
 * (BroadcastBoardCard через prop `evalCp`/`evalMate`) рендерит bar.
 *
 * Если WASM Stockfish недоступен (старый браузер, нет Worker support) —
 * хук возвращает пустой `evals` и `enqueue` no-op. UI рендерится без
 * bar, без падений.
 */

export interface EvalSnapshot {
  /** cp оценка POV white (положительная — преимущество белых). */
  cp: number | null;
  /** mate за столько полу-ходов; знак как у cp. null если не mate. */
  mate: number | null;
  /** depth, на которой получена оценка. */
  depth: number;
}

export interface UseBroadcastEvalQueueResult {
  evals: Record<string, EvalSnapshot>;
  enqueue: (gameKey: string, fen: string) => void;
  /** true если worker инициализирован и можно анализировать. */
  ready: boolean;
}

const DEFAULT_DEPTH = 10;

export function useBroadcastEvalQueue(): UseBroadcastEvalQueueResult {
  const [evals, setEvals] = useState<Record<string, EvalSnapshot>>({});
  const [ready, setReady] = useState(false);
  const engineRef = useRef<WasmEngineAdapter | null>(null);
  const queueRef = useRef<Map<string, string>>(new Map());
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);

  // Инициализация worker'а при mount, destroy при unmount.
  useEffect(() => {
    cancelledRef.current = false;
    let engine: WasmEngineAdapter | null = null;
    void (async () => {
      try {
        engine = new WasmEngineAdapter();
        await engine.init();
        if (cancelledRef.current) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        setReady(true);
        // Если в очереди что-то накопилось до init'а — стартанём run-loop.
        if (queueRef.current.size > 0) processQueue();
      } catch (e) {
        console.warn('[evalQueue] failed to init Stockfish', e);
      }
    })();
    const queueAtMount = queueRef.current;
    return () => {
      cancelledRef.current = true;
      try {
        engineRef.current?.destroy();
      } catch {
        /* ignore */
      }
      engineRef.current = null;
      queueAtMount.clear();
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processQueue = useCallback((): void => {
    if (runningRef.current) return;
    if (!engineRef.current) return;
    if (queueRef.current.size === 0) return;
    runningRef.current = true;
    void (async () => {
      while (queueRef.current.size > 0 && !cancelledRef.current) {
        const it = queueRef.current.entries().next();
        if (it.done) break;
        const [key, fen] = it.value;
        queueRef.current.delete(key);
        try {
          const res = await engineRef.current!.analyze(
            fen,
            DEFAULT_DEPTH,
            1,
          );
          if (cancelledRef.current) break;
          const line = res.lines[0];
          if (!line) continue;
          // POV side-to-move у Stockfish; нормализуем на POV white.
          const isWhiteToMove = fen.split(' ')[1] !== 'b';
          const sign = isWhiteToMove ? 1 : -1;
          const snap: EvalSnapshot =
            line.score.type === 'mate'
              ? {
                  cp: null,
                  mate: line.score.value * sign,
                  depth: line.depth,
                }
              : {
                  cp: line.score.value * sign,
                  mate: null,
                  depth: line.depth,
                };
          setEvals((prev) => ({ ...prev, [key]: snap }));
        } catch (e) {
          console.warn('[evalQueue] analyze failed', e);
        }
      }
      runningRef.current = false;
    })();
  }, []);

  const enqueue = useCallback(
    (gameKey: string, fen: string) => {
      if (!gameKey || !fen) return;
      // Replace-by-key: если эта партия уже запланирована — её
      // прежний FEN перезаписывается новым (только последний имеет
      // смысл для live-обзора).
      queueRef.current.set(gameKey, fen);
      if (engineRef.current) processQueue();
    },
    [processQueue],
  );

  return { evals, enqueue, ready };
}
