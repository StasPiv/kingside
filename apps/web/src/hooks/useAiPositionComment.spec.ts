/**
 * KS-3680. Тесты `useAiPositionComment` — LRU-кэш по нормализованному FEN,
 * отмена при смене позиции, парсинг 429 с `retryAfter`, состояние
 * `unsupported` при отказе движка, soft-counter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  _resetAiPositionCommentCacheForTests,
  normalizeFen,
  SOFT_LIMIT,
  SOFT_WINDOW_MIN,
  useAiPositionComment,
} from './useAiPositionComment';

// Подменяем `evalTrace`, чтобы не поднимать WASM в тестах.
vi.mock('../lib/review/stockfishTrace', () => ({
  evalTrace: vi.fn(),
}));
import { evalTrace } from '../lib/review/stockfishTrace';

const FEN_A = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_B = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('normalizeFen', () => {
  it('сохраняет первые 4 поля, отбрасывает halfmove/fullmove', () => {
    expect(
      normalizeFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
    expect(
      normalizeFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 250'),
    ).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  });
});

describe('useAiPositionComment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetAiPositionCommentCacheForTests();
    localStorage.clear();
    localStorage.setItem('token', 'jwt-test');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('гость → state.kind=unauthenticated, fetch не вызывается', async () => {
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: null }),
    );
    expect(result.current.state.kind).toBe('unauthenticated');
    act(() => result.current.request());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('unauthenticated');
  });

  it('успешный запрос → state.kind=success, source=live; повторный → cache', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'space', value_mg: 0.1, value_eg: 0 },
    ]);
    fetchSpy.mockResolvedValue(jsonResponse({ comment: 'нормальная позиция' }));
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: { id: 'u1' } }),
    );
    expect(result.current.state.kind).toBe('idle');
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    expect(result.current.state).toMatchObject({
      kind: 'success',
      comment: 'нормальная позиция',
      source: 'live',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Повторный запрос на ту же позицию — должен взять кэш.
    act(() => result.current.request());
    expect(result.current.state).toMatchObject({
      kind: 'success',
      source: 'cache',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('кэш-hit при возврате на ранее запрошенный FEN через rerender', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchSpy.mockResolvedValue(jsonResponse({ comment: 'A-комментарий' }));

    const { result, rerender } = renderHook(
      (props: { fen: string }) =>
        useAiPositionComment({ fen: props.fen, user: { id: 'u1' } }),
      { initialProps: { fen: FEN_A } },
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));

    // Уходим на FEN_B — idle (нет ничего в кэше).
    rerender({ fen: FEN_B });
    expect(result.current.state.kind).toBe('idle');

    // Возвращаемся на FEN_A — кэш-hit, fetch не дёргается.
    rerender({ fen: FEN_A });
    expect(result.current.state).toMatchObject({
      kind: 'success',
      source: 'cache',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('смена FEN отменяет in-flight запрос', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    let abortedFirst = false;
    fetchSpy.mockImplementation((_url: unknown, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve, reject) => {
        sig?.addEventListener('abort', () => {
          abortedFirst = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        // Никогда не резолвим сами — только через abort.
      });
    });

    const { result, rerender } = renderHook(
      (props: { fen: string }) =>
        useAiPositionComment({ fen: props.fen, user: { id: 'u1' } }),
      { initialProps: { fen: FEN_A } },
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('loading'));

    rerender({ fen: FEN_B });
    await waitFor(() => expect(abortedFirst).toBe(true));
    // После смены FEN состояние сбрасывается на idle (нового запроса не было).
    expect(result.current.state.kind).toBe('idle');
  });

  it('429 → state.kind=rate-limited с retryAfter из тела', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchSpy.mockResolvedValue(
      jsonResponse(
        { error: 'rate_limit', retryAfter: 42, limits: {} },
        { status: 429 },
      ),
    );
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: { id: 'u1' } }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('rate-limited'));
    expect(result.current.state).toMatchObject({
      kind: 'rate-limited',
      retryAfterSec: 42,
    });
  });

  it('429 без тела → fallback на заголовок Retry-After', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchSpy.mockResolvedValue(
      new Response('', { status: 429, headers: { 'Retry-After': '17' } }),
    );
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: { id: 'u1' } }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('rate-limited'));
    expect(result.current.state).toMatchObject({
      kind: 'rate-limited',
      retryAfterSec: 17,
    });
  });

  it('evalTrace бросает → state.kind=unsupported, fetch не вызывается', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no SharedArrayBuffer'),
    );
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: { id: 'u1' } }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('unsupported'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('5xx → state.kind=error', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchSpy.mockResolvedValue(new Response('boom', { status: 502 }));
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: { id: 'u1' } }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
  });

  it('пустой comment → state.kind=empty + кэш-hit на повторе', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchSpy.mockResolvedValue(jsonResponse({ comment: '' }));
    const { result } = renderHook(() =>
      useAiPositionComment({ fen: FEN_A, user: { id: 'u1' } }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('empty'));

    act(() => result.current.request());
    expect(result.current.state.kind).toBe('empty');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fullReviewComment → success(source=full-review) до ручного запроса', () => {
    const { result } = renderHook(() =>
      useAiPositionComment({
        fen: FEN_A,
        user: { id: 'u1' },
        fullReviewComment: 'из полного разбора',
      }),
    );
    expect(result.current.state).toMatchObject({
      kind: 'success',
      source: 'full-review',
      comment: 'из полного разбора',
    });
  });

  it('regenerate перезаписывает fullReviewComment-состояние ответом API (source=live)', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    fetchSpy.mockResolvedValue(jsonResponse({ comment: 'свежий комментарий' }));
    const { result } = renderHook(() =>
      useAiPositionComment({
        fen: FEN_A,
        user: { id: 'u1' },
        fullReviewComment: 'старый',
      }),
    );
    expect(result.current.state).toMatchObject({ source: 'full-review' });
    act(() => result.current.regenerate());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    expect(result.current.state).toMatchObject({
      source: 'live',
      comment: 'свежий комментарий',
    });
  });

  it('KS-3685: engineBestLine добавляет sf18_eval + sf18_pv в factors', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'space', value_mg: 0.05, value_eg: 0 },
    ]);
    let capturedBody: Record<string, unknown> | null = null;
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({ comment: 'ok' });
    });
    const { result } = renderHook(() =>
      useAiPositionComment({
        fen: FEN_A,
        user: { id: 'u1' },
        engineBestLine: {
          depth: 24,
          multipv: 1,
          score: { type: 'cp', value: 35 },
          pv: 'e2e4 e7e5 g1f3',
        },
      }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    expect(capturedBody).not.toBeNull();
    const factors = (capturedBody as unknown as { factors: unknown[] }).factors;
    expect(Array.isArray(factors)).toBe(true);
    // Базовый фактор + sf18_eval + sf18_pv.
    expect(factors).toHaveLength(3);
    expect(factors[1]).toMatchObject({
      id: 'sf18_eval',
      engine: 'stockfish-18',
      depth: 24,
      multipv: 1,
      score: { type: 'cp', value: 35 },
      side_to_move: 'w',
    });
    expect(factors[2]).toMatchObject({
      id: 'sf18_pv',
      engine: 'stockfish-18',
      depth: 24,
      multipv: 1,
      pv: ['e2e4', 'e7e5', 'g1f3'],
    });
  });

  it('KS-3685: engineBestLine=null → factors без sf18-элементов, запрос идёт', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'space', value_mg: 0.05, value_eg: 0 },
    ]);
    let capturedBody: Record<string, unknown> | null = null;
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({ comment: 'ok' });
    });
    const { result } = renderHook(() =>
      useAiPositionComment({
        fen: FEN_A,
        user: { id: 'u1' },
        engineBestLine: null,
      }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    const factors = (capturedBody as unknown as { factors: unknown[] }).factors;
    expect(factors).toHaveLength(1);
    expect((factors[0] as { id: string }).id).toBe('space');
  });

  it('KS-3685: engineBestLine с пустым pv → только sf18_eval (без sf18_pv)', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    let capturedBody: Record<string, unknown> | null = null;
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({ comment: 'ok' });
    });
    const { result } = renderHook(() =>
      useAiPositionComment({
        fen: FEN_A,
        user: { id: 'u1' },
        engineBestLine: {
          depth: 18,
          multipv: 1,
          score: { type: 'mate', value: 3 },
          pv: '   ',
        },
      }),
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    const factors = (capturedBody as unknown as { factors: unknown[] }).factors;
    expect(factors).toHaveLength(1);
    expect(factors[0]).toMatchObject({
      id: 'sf18_eval',
      score: { type: 'mate', value: 3 },
    });
  });

  it('soft-counter растёт на каждый отправленный запрос', async () => {
    (evalTrace as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // mockResolvedValue вернул бы один и тот же Response — `res.json()`
    // консумирует body, второй вызов упадёт. Поэтому новая Response на
    // каждый fetch.
    fetchSpy.mockImplementation(async () => jsonResponse({ comment: 'ok' }));
    const { result, rerender } = renderHook(
      (props: { fen: string }) =>
        useAiPositionComment({ fen: props.fen, user: { id: 'u1' } }),
      { initialProps: { fen: FEN_A } },
    );
    expect(result.current.softCounter).toEqual({
      used: 0,
      limit: SOFT_LIMIT,
      windowMin: SOFT_WINDOW_MIN,
    });
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    expect(result.current.softCounter.used).toBe(1);

    // Запрос на новой позиции — счётчик дальше +1.
    rerender({ fen: FEN_B });
    act(() => result.current.request());
    await waitFor(() => expect(result.current.state.kind).toBe('success'));
    expect(result.current.softCounter.used).toBe(2);
  });
});
