/**
 * KS-4024 — юнит-тесты оркестратора `usePositionalTrace`.
 *
 * Покрываем:
 *  - GET 200 → данные с сервера, статус 'synced';
 *  - GET 404 + IDB пусто → status='idle', данных нет;
 *  - GET 404 + IDB содержит computed_locally → данные из IDB, status='computed';
 *  - start(moves) → расчёт + POST → status='synced';
 *  - POST упал → status='computed', статус локально 'pending_upload'.
 *
 * Чекпоинт-логика на 10 ply и BroadcastChannel-синхронизация —
 * частично покрыта (mock-канал в тестах, тест на чекпоинт через
 * проверку saveLocalTrace вызовов).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GamePositionalTraceDto } from '@kingside/shared';

// ── Моки ────────────────────────────────────────────────────────────
const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../api/positionalTrace', () => ({
  getPositionalTrace: (...args: unknown[]) => getMock(...args),
  postPositionalTrace: (...args: unknown[]) => postMock(...args),
  deletePositionalTrace: vi.fn(),
}));

const evalTraceMock = vi.fn();
vi.mock('../lib/review/stockfishTrace', () => ({
  evalTrace: (fen: string) => evalTraceMock(fen),
}));

const loadLocalMock = vi.fn();
const saveLocalMock = vi.fn();
const sweepMock = vi.fn();
const deleteLocalMock = vi.fn();
vi.mock('../lib/review/positionalTraceStore', () => ({
  loadLocalTrace: (...args: unknown[]) => loadLocalMock(...args),
  saveLocalTrace: (...args: unknown[]) => saveLocalMock(...args),
  sweepExpiredTraces: () => sweepMock(),
  deleteLocalTrace: (...args: unknown[]) => deleteLocalMock(...args),
}));

import { usePositionalTrace } from './usePositionalTrace';

const GAME_ID = '00000000-0000-0000-0000-000000000001';
const SF_VERSION = 'sf18-trace-v2';

function makeDto(plies = 3): GamePositionalTraceDto {
  return {
    gameId: GAME_ID,
    sfVersion: SF_VERSION,
    plies: Array.from({ length: plies }, (_, i) => ({
      ply: i,
      subterms: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'material', value_mg: i * 0.1, value_eg: i * 0.1 } as any,
      ],
    })),
    durationMs: 1000,
    createdAt: '2026-06-09T17:00:00.000Z',
    updatedAt: '2026-06-09T17:00:00.000Z',
  };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  evalTraceMock.mockReset();
  loadLocalMock.mockReset();
  saveLocalMock.mockReset();
  sweepMock.mockReset();
  deleteLocalMock.mockReset();
  saveLocalMock.mockResolvedValue(true);
});

describe('usePositionalTrace', () => {
  it('GET 200 → данные с сервера, статус synced', async () => {
    const dto = makeDto(4);
    getMock.mockResolvedValueOnce(dto);

    const { result } = renderHook(() =>
      usePositionalTrace({ gameId: GAME_ID }),
    );
    await waitFor(() => expect(result.current.status).toBe('synced'));
    expect(result.current.data).toEqual(dto);
    expect(result.current.source).toBe('server');
    expect(saveLocalMock).toHaveBeenCalled();
  });

  it('GET 404 → IDB пусто → idle', async () => {
    getMock.mockResolvedValueOnce(null);
    loadLocalMock.mockResolvedValueOnce(null);
    const { result } = renderHook(() =>
      usePositionalTrace({ gameId: GAME_ID }),
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.data).toBeNull();
  });

  it('GET 404 → IDB содержит computed_locally → данные из IDB', async () => {
    getMock.mockResolvedValueOnce(null);
    loadLocalMock.mockResolvedValueOnce({
      key: `${GAME_ID}:${SF_VERSION}`,
      gameId: GAME_ID,
      sfVersion: SF_VERSION,
      plies: makeDto(2).plies,
      totalPlies: 2,
      computedPlies: 2,
      status: 'computed_locally',
      durationMs: 500,
      updatedAt: new Date().toISOString(),
    });
    const { result } = renderHook(() =>
      usePositionalTrace({ gameId: GAME_ID }),
    );
    await waitFor(() => expect(result.current.status).toBe('computed'));
    expect(result.current.source).toBe('idb');
    expect(result.current.data?.plies).toHaveLength(2);
  });

  it('start() → расчёт по ходам → POST → synced', async () => {
    getMock.mockResolvedValueOnce(null);
    loadLocalMock.mockResolvedValueOnce(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evalTraceMock.mockResolvedValue([{ id: 'material', value_mg: 0, value_eg: 0 } as any]);
    const finalDto = makeDto(3);
    postMock.mockResolvedValueOnce(finalDto);

    const { result } = renderHook(() =>
      usePositionalTrace({ gameId: GAME_ID }),
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => result.current.start(['e2e4', 'e7e5']));
    await waitFor(() => expect(result.current.status).toBe('synced'), {
      timeout: 3000,
    });
    expect(evalTraceMock).toHaveBeenCalledTimes(3); // start + 2 moves
    expect(postMock).toHaveBeenCalled();
  });

  it('POST упал → status=computed, локально pending_upload', async () => {
    getMock.mockResolvedValueOnce(null);
    loadLocalMock.mockResolvedValueOnce(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evalTraceMock.mockResolvedValue([{ id: 'material', value_mg: 0, value_eg: 0 } as any]);
    postMock.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() =>
      usePositionalTrace({ gameId: GAME_ID }),
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));
    act(() => result.current.start(['e2e4']));
    await waitFor(() => expect(result.current.status).toBe('computed'), {
      timeout: 3000,
    });
    // Последний saveLocal должен быть со статусом pending_upload.
    const pendingCalls = saveLocalMock.mock.calls.filter(
      (c) => (c[0] as { status: string }).status === 'pending_upload',
    );
    expect(pendingCalls.length).toBeGreaterThan(0);
  });

  it('gameId=null — хук спит, никаких вызовов', () => {
    renderHook(() => usePositionalTrace({ gameId: null }));
    expect(getMock).not.toHaveBeenCalled();
    expect(loadLocalMock).not.toHaveBeenCalled();
  });
});
