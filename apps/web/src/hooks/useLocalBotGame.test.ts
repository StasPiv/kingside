/**
 * KS-4150 / KS-4655 — юнит-тесты источника данных локальной партии
 * с ботом. После KS-4655 часы хука перешли в миллисекунды
 * (`clocksMs: { whiteMs, blackMs, snapshotAt }`), локальный
 * `setInterval(250)` удалён, точный отсчёт делает
 * `useGameClockDisplay` на стороне страницы.
 *
 * `useBotEngine` мокается: `getBotMove` отдаёт предсказуемый ответ,
 * `engineError`/`retryEngine` тоже подсовываем минимальные значения,
 * чтобы хук не падал при разрушении интерфейса.
 *
 * `performance.now()` мокается через spyOn — в fake-timer'ах vitest
 * он по умолчанию НЕ замораживается; нам нужен детерминированный
 * elapsed для проверки списания/инкремента.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getBotMoveMock = vi.fn();
const retryEngineMock = vi.fn();
vi.mock('./useBotEngine', () => ({
  useBotEngine: () => ({
    getBotMove: getBotMoveMock,
    engineError: null,
    retryEngine: retryEngineMock,
  }),
}));

vi.mock('../utils/clientLogger', () => ({
  sendClientLog: vi.fn(),
}));

vi.mock('../lib/botEngineDebug', () => ({
  logBotEngineDebug: vi.fn(),
}));

import { useLocalBotGame } from './useLocalBotGame';

describe('useLocalBotGame', () => {
  let now = 0;

  beforeEach(() => {
    getBotMoveMock.mockReset();
    retryEngineMock.mockReset();
    vi.useFakeTimers();
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('инициализируется в active с мс-часами равными initialMs', () => {
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        level: 3,
        timeControl: { initialSec: 600, incrementSec: 0 },
      }),
    );
    expect(result.current.status).toBe('active');
    expect(result.current.playerColor).toBe('white');
    expect(result.current.clocksMs.whiteMs).toBe(600_000);
    expect(result.current.clocksMs.blackMs).toBe(600_000);
    expect(result.current.clocksMs.snapshotAt).toBe(1_000);
    expect(result.current.initialMs).toBe(600_000);
    expect(result.current.moves).toEqual([]);
    expect(result.current.result).toBeNull();
    expect(result.current.lastMove).toBeNull();
  });

  it('ход игрока обновляет moves, fen, lastMove; ход переходит к боту', async () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({ color: 'white', level: 3 }),
    );
    act(() => {
      const ok = result.current.onMove(
        'e2' as unknown as never,
        'e4' as unknown as never,
      );
      expect(ok).toBe(true);
    });
    expect(result.current.moves).toEqual(['e4']);
    expect(result.current.lastMove?.from).toBe('e2');
    expect(result.current.lastMove?.to).toBe('e4');
    expect(result.current.lastMove?.ply).toBe(1);
    expect(result.current.fen).toContain('b KQkq');
    expect(result.current.chess.turn()).toBe('b');
  });

  it('сдаться → status=finished, результат у соперника', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({ color: 'white' }),
    );
    act(() => result.current.onResign());
    expect(result.current.status).toBe('finished');
    expect(result.current.result).toBe('black');
  });

  it('новая партия сбрасывает доску и мс-часы', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        timeControl: { initialSec: 600 },
      }),
    );
    act(() => {
      result.current.onMove(
        'e2' as unknown as never,
        'e4' as unknown as never,
      );
    });
    // Сдвигаем «часы» и перезапускаем партию — снимок должен встать
    // на новое `now` со свежими мс.
    now = 5_000;
    act(() => result.current.onNewGame());
    expect(result.current.moves).toEqual([]);
    expect(result.current.lastMove).toBeNull();
    expect(result.current.status).toBe('active');
    expect(result.current.result).toBeNull();
    expect(result.current.clocksMs.whiteMs).toBe(600_000);
    expect(result.current.clocksMs.blackMs).toBe(600_000);
    expect(result.current.clocksMs.snapshotAt).toBe(5_000);
  });

  it('инкремент прибавляется в мс к часам того, кто только что походил', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        timeControl: { initialSec: 300, incrementSec: 5 },
      }),
    );
    // Симулируем 2 000 мс размышлений до хода.
    now = 3_000;
    act(() => {
      result.current.onMove(
        'e2' as unknown as never,
        'e4' as unknown as never,
      );
    });
    // 300_000 - 2_000 + 5_000 = 303_000.
    expect(result.current.clocksMs.whiteMs).toBe(303_000);
    // Чёрные не тратили — не списались.
    expect(result.current.clocksMs.blackMs).toBe(300_000);
    // Snapshot обновился на момент хода.
    expect(result.current.clocksMs.snapshotAt).toBe(3_000);
  });

  it('игрок не может ходить не в свою очередь', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({ color: 'black' }),
    );
    let returned = true;
    act(() => {
      returned = result.current.onMove(
        'e7' as unknown as never,
        'e5' as unknown as never,
      );
    });
    expect(returned).toBe(false);
    expect(result.current.moves).toEqual([]);
  });

  it('флаг по нулю активной стороны → status=finished, выигрыш соперника', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        timeControl: { initialSec: 10 }, // floor — 10 c минимум
      }),
    );
    // Часы активной (белых) — 10 000 мс. Прокручиваем setTimeout
    // ровно на этот intervalo.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.status).toBe('finished');
    expect(result.current.result).toBe('black');
  });

  it('noClock=true → setTimeout-флаг не запускается, часы не меняются', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        timeControl: { initialSec: 10, noClock: true },
      }),
    );
    expect(result.current.noClock).toBe(true);
    expect(result.current.initialMs).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Даже через минуту таймер не сработал.
    expect(result.current.status).toBe('active');
    expect(result.current.result).toBeNull();
  });
});
