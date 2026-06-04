/**
 * KS-3682. Утилита для проверки `stockfish-16-trace` из консоли браузера
 * независимо от разбора партии.
 *
 *   await window.__sfTrace()         // текущая позиция со страницы анализа
 *   await window.__sfTrace('<fen>')  // произвольная позиция
 *
 * Возвращает массив `PositionalSubterm[]` — то же, что уходит на бэкенд
 * в `facts[].positional_subterms`. Если массив непустой — исполнитель
 * работает. Если пустой / бросает `StockfishTraceEngineError` — видно,
 * что именно сломалось.
 *
 * Текущий FEN со страницы анализа выставляется в `window.__sfTraceFen`
 * из AnalysisPage (useEffect на смену позиции).
 */
import { evalTrace } from '../stockfishTrace';
import type { PositionalSubterm } from '@kingside/shared';

declare global {
  interface Window {
    __sfTrace?: (fen?: string) => Promise<PositionalSubterm[]>;
    __sfTraceFen?: string;
  }
}

if (typeof window !== 'undefined') {
  window.__sfTrace = (fen?: string) => {
    const target = fen ?? window.__sfTraceFen;
    if (!target) {
      return Promise.reject(
        new Error(
          'window.__sfTraceFen не выставлен (открой страницу анализа) или передай fen явно: window.__sfTrace("<fen>")',
        ),
      );
    }
    return evalTrace(target);
  };
  // eslint-disable-next-line no-console
  console.info(
    '[sfTraceConsole] window.__sfTrace() готов: без аргумента берёт window.__sfTraceFen (со страницы анализа), с аргументом — произвольный FEN',
  );
}
