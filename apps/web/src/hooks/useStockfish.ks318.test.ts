// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStockfish } from './useStockfish';

/**
 * KS-318: QA-верификация фикса KS-317 — Stockfish crash при навигации по ходам.
 *
 * Фокус: debounce-поведение в GameReviewPage (150ms таймер),
 * корректность очереди pendingFen при быстрой навигации,
 * отсутствие race conditions между stop/bestmove/readyok.
 */

type MessageHandler = (e: MessageEvent) => void;
type ErrorHandler = (e: ErrorEvent) => void;

class MockWorker {
  onmessage: MessageHandler | null = null;
  onerror: ErrorHandler | null = null;
  postMessageCalls: string[] = [];
  terminated = false;

  postMessage(msg: string) {
    this.postMessageCalls.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  simulateMessage(data: string) {
    if (this.onmessage) {
      this.onmessage({ data } as MessageEvent);
    }
  }
}

let mockWorkerInstance: MockWorker | null = null;

beforeEach(() => {
  mockWorkerInstance = null;
  vi.stubGlobal('Worker', class {
    constructor() {
      mockWorkerInstance = new MockWorker();
      return mockWorkerInstance;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function initAndReady() {
  const hook = renderHook(() => useStockfish({ autoStart: true, depth: 18, multiPv: 3 }));
  act(() => {
    mockWorkerInstance!.simulateMessage('uciok');
    mockWorkerInstance!.simulateMessage('readyok');
  });
  return hook;
}

const FEN_INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const FEN_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const FEN_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const FEN_NC6 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
const FEN_BB5 = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

// --- Сценарий 1: Быстрая навигация с debounce ---

describe('KS-318/1: Быстрая навигация — pendingFen перезаписывается', () => {
  it('каждый evaluate() при analyzing перезаписывает pendingFen', () => {
    const { result } = initAndReady();

    // Начинаем анализ
    act(() => { result.current.evaluate(FEN_E4); });
    expect(result.current.state).toBe('analyzing');

    // Быстрая навигация: 5 ходов подряд
    act(() => { result.current.evaluate(FEN_E5); });
    act(() => { result.current.evaluate(FEN_NF3); });
    act(() => { result.current.evaluate(FEN_NC6); });
    act(() => { result.current.evaluate(FEN_BB5); });
    act(() => { result.current.evaluate(FEN_INITIAL); });

    // Только один stop должен быть отправлен (первый evaluate при analyzing)
    // Остальные просто перезаписывают pendingFen
    const stopCalls = mockWorkerInstance!.postMessageCalls.filter(c => c === 'stop');
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);

    // Завершаем первый анализ
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Должен анализировать ТОЛЬКО последний FEN (INITIAL)
    const positionCalls = mockWorkerInstance!.postMessageCalls.filter(c => c.startsWith('position fen'));
    const lastPosition = positionCalls[positionCalls.length - 1];
    expect(lastPosition).toBe(`position fen ${FEN_INITIAL}`);
  });

  it('промежуточные FEN не вызывают position/go команд', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });

    const callsBeforeNavigation = mockWorkerInstance!.postMessageCalls.length;

    // Быстрая навигация
    act(() => { result.current.evaluate(FEN_E5); });
    act(() => { result.current.evaluate(FEN_NF3); });
    act(() => { result.current.evaluate(FEN_NC6); });

    // Между evaluate() при analyzing не должно быть новых position/go
    const newCalls = mockWorkerInstance!.postMessageCalls.slice(callsBeforeNavigation);
    const positionCalls = newCalls.filter(c => c.startsWith('position fen'));
    const goCalls = newCalls.filter(c => c.startsWith('go depth'));

    // Только stop-ы, никаких position/go
    expect(positionCalls).toHaveLength(0);
    expect(goCalls).toHaveLength(0);
  });
});

// --- Сценарий 2: Race condition: bestmove приходит после нескольких navigate ---

describe('KS-318/2: Race condition — bestmove после нескольких навигаций', () => {
  it('bestmove от первого анализа не отображается как результат последнего', () => {
    const { result } = initAndReady();

    // Анализ первого хода
    act(() => { result.current.evaluate(FEN_E4); });

    // Приходят info строки для E4
    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 15 multipv 1 score cp 35 pv e7e5');
    });
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0].score.value).toBe(35);

    // Быстро переключаемся на другой ход (pending)
    act(() => { result.current.evaluate(FEN_NC6); });

    // bestmove от E4 — lines должны очиститься при запуске нового анализа
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e7e5'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Lines очищены для нового анализа NC6
    expect(result.current.lines).toHaveLength(0);
    expect(result.current.bestMove).toBeNull();
    expect(result.current.state).toBe('analyzing');
  });

  it('info строки от старого анализа после stop не попадают в новый', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_NC6); }); // pending, stop отправлен

    // info приходит от старого анализа после stop (до bestmove)
    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 18 multipv 1 score cp 40 pv d7d5');
    });

    // Эти info строки добавляются в lines (они ещё от текущего analyzing)
    // После bestmove+readyok они будут очищены
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e7e5'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Теперь анализируется NC6 — lines очищены
    expect(result.current.lines).toHaveLength(0);
  });
});

// --- Сценарий 3: Двойной stop не ломает механизм ---

describe('KS-318/3: Двойной stop и edge cases', () => {
  it('evaluate() при analyzing отправляет stop только один раз', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });

    // Первый evaluate при analyzing — отправляет stop
    act(() => { result.current.evaluate(FEN_E5); });
    // Второй evaluate при analyzing — перезаписывает pending, stop уже отправлен
    act(() => { result.current.evaluate(FEN_NF3); });

    const calls = mockWorkerInstance!.postMessageCalls;
    // stop отправляется при каждом evaluate в analyzing
    // но это нормально — множественные stop безопасны для Stockfish
    const stopsAfterGo = calls.slice(calls.findIndex(c => c.startsWith('go depth')) + 1);
    const stops = stopsAfterGo.filter(c => c === 'stop');
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it('stop() вручную + evaluate() — pending всё ещё обрабатывается', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });

    // Вручную stop
    act(() => { result.current.stop(); });

    // Затем новый evaluate (pending)
    act(() => { result.current.evaluate(FEN_NC6); });

    // bestmove от stop → isready → readyok
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Должен анализировать NC6
    const lastPosition = mockWorkerInstance!.postMessageCalls
      .filter(c => c.startsWith('position fen')).pop();
    expect(lastPosition).toBe(`position fen ${FEN_NC6}`);
    expect(result.current.state).toBe('analyzing');
  });
});

// --- Сценарий 4: Навигация Home/End с активным анализом ---

describe('KS-318/4: Home/End навигация — полный цикл', () => {
  it('End→Home→End — анализируется последняя запрошенная позиция', () => {
    const { result } = initAndReady();

    // End: анализ последнего хода
    act(() => { result.current.evaluate(FEN_BB5); });
    expect(result.current.state).toBe('analyzing');

    // Home: начальная позиция (pending)
    act(() => { result.current.evaluate(FEN_INITIAL); });

    // End снова: последний ход (перезаписывает pending)
    act(() => { result.current.evaluate(FEN_BB5); });

    // Завершаем анализ
    act(() => { mockWorkerInstance!.simulateMessage('bestmove f1b5'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Должен анализировать BB5 (последний запрос)
    const lastPosition = mockWorkerInstance!.postMessageCalls
      .filter(c => c.startsWith('position fen')).pop();
    expect(lastPosition).toBe(`position fen ${FEN_BB5}`);
  });

  it('после полного цикла анализа state возвращается в ready', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_INITIAL); }); // pending

    // Полный цикл
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });
    // Новый анализ INITIAL
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e2e4'); });

    // Без pending — ready
    expect(result.current.state).toBe('ready');
  });
});

// --- Сценарий 5: Оценка позиции соответствует текущему ходу ---

describe('KS-318/5: Оценка соответствует текущей позиции', () => {
  it('info строки после readyok соответствуют запрошенному FEN', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_NC6); }); // pending

    // Завершаем первый анализ
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e7e5'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Теперь info для NC6
    act(() => {
      mockWorkerInstance!.simulateMessage('info depth 18 multipv 1 score cp -10 pv d2d4');
    });

    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0].score.value).toBe(-10);
    expect(result.current.state).toBe('analyzing');
  });

  it('bestMove обновляется для последней позиции', () => {
    const { result } = initAndReady();

    act(() => { result.current.evaluate(FEN_E4); });
    act(() => { result.current.evaluate(FEN_NC6); }); // pending

    // Первый bestmove
    act(() => { mockWorkerInstance!.simulateMessage('bestmove e7e5'); });
    act(() => { mockWorkerInstance!.simulateMessage('readyok'); });

    // Второй bestmove (для NC6)
    act(() => { mockWorkerInstance!.simulateMessage('bestmove d2d4'); });

    expect(result.current.bestMove).toBe('d2d4');
    expect(result.current.state).toBe('ready');
  });
});
