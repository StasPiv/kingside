/**
 * KS-4150 — юнит-тесты источника данных локальной партии с ботом.
 * Stockfish-движок мокирован: `getBotMove` отдаёт заранее заданный
 * ответ, чтобы тест не зависел от реального WASM-воркера.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getBotMoveMock = vi.fn();
vi.mock('./useBotEngine', () => ({
  useBotEngine: () => ({ getBotMove: getBotMoveMock }),
}));

vi.mock('../utils/clientLogger', () => ({
  sendClientLog: vi.fn(),
}));

import { useLocalBotGame } from './useLocalBotGame';

describe('useLocalBotGame', () => {
  beforeEach(() => {
    getBotMoveMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('инициализируется в active со стартовыми часами', () => {
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        level: 3,
        timeControl: { initialSec: 600, incrementSec: 0 },
      }),
    );
    expect(result.current.status).toBe('active');
    expect(result.current.playerColor).toBe('white');
    expect(result.current.clocks).toEqual({ white: 600, black: 600 });
    expect(result.current.moves).toEqual([]);
    expect(result.current.result).toBeNull();
    expect(result.current.lastMove).toBeNull();
  });

  it('ход игрока обновляет moves, fen и lastMove; ход переходит к боту', async () => {
    getBotMoveMock.mockImplementation(
      () => new Promise(() => {}), // навсегда подвисает — ход бота не успевает примениться
    );
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
    // Очередь хода теперь у чёрных (бот).
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

  it('новая партия сбрасывает доску, часы, lastMove и moves', () => {
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
    act(() => result.current.onNewGame());
    expect(result.current.moves).toEqual([]);
    expect(result.current.lastMove).toBeNull();
    expect(result.current.status).toBe('active');
    expect(result.current.result).toBeNull();
    expect(result.current.clocks).toEqual({ white: 600, black: 600 });
  });

  it('инкремент прибавляется к часам того, кто походил', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({
        color: 'white',
        timeControl: { initialSec: 300, incrementSec: 5 },
      }),
    );
    act(() => {
      result.current.onMove(
        'e2' as unknown as never,
        'e4' as unknown as never,
      );
    });
    expect(result.current.clocks.white).toBe(305);
    expect(result.current.clocks.black).toBe(300);
  });

  it('игрок не может ходить не в свою очередь', () => {
    getBotMoveMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useLocalBotGame({ color: 'black' }),
    );
    // Сейчас ход белых (бота), игрок чёрный — попытка ходить должна
    // быть отвергнута.
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
});
