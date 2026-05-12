import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useStudyChapterPersistence } from './useStudyChapterPersistence';

/**
 * KS-2834 (KS-2815 T18) — unit-тесты auto-save главы.
 *
 * Проверяем:
 *   - Debounce 1000ms: до таймера PATCH не вызывается.
 *   - После таймера → studiesApi.updateChapter вызван c сериализованным PGN.
 *   - Изменение пропов в течение debounce — таймер перезапускается
 *     (без дублирующих сохранений).
 *   - Без auth-токена → skip.
 *   - Без slug/chapterId → skip.
 *   - Пустая history + нет initialAnnotations → skip.
 */

const updateChapterMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    updateChapter: (slug: string, chapterId: string, req: unknown) =>
      updateChapterMock(slug, chapterId, req),
  },
}));

vi.mock('../review/utils/PgnSerializer', () => ({
  serializeToAnnotatedPgn: (history: unknown[]) =>
    `serialized:${history.length}`,
}));

const SAMPLE_MOVE = {
  san: 'e4',
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  from: 'e2',
  to: 'e4',
  piece: 'p',
  captured: undefined,
  promotion: undefined,
  flags: 'b',
  lan: 'e2e4',
  before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  globalIndex: 0,
  ply: 1,
};

beforeEach(() => {
  updateChapterMock.mockReset();
  updateChapterMock.mockResolvedValue(undefined);
  localStorage.setItem('token', 'fake-token');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem('token');
});

describe('useStudyChapterPersistence (KS-2827/KS-2834)', () => {
  it('debounce 1000ms — до таймера PATCH не вызывается', () => {
    renderHook(() =>
      useStudyChapterPersistence(
        'demo',
        'ch1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [SAMPLE_MOVE] as any,
      ),
    );
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(updateChapterMock).not.toHaveBeenCalled();
  });

  it('после 1000ms → updateChapter с сериализованным PGN', () => {
    renderHook(() =>
      useStudyChapterPersistence(
        'demo',
        'ch1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [SAMPLE_MOVE] as any,
      ),
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateChapterMock).toHaveBeenCalledWith('demo', 'ch1', {
      pgn: 'serialized:1',
    });
  });

  it('изменение history в течение debounce → таймер перезапускается', () => {
    const { rerender } = renderHook(
      ({ history }) =>
        useStudyChapterPersistence(
          'demo',
          'ch1',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          history as any,
        ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { initialProps: { history: [SAMPLE_MOVE] as any } },
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Меняем historу → debounce перезапустится.
    rerender({
      history: [SAMPLE_MOVE, { ...SAMPLE_MOVE, san: 'e5', globalIndex: 1 }] as unknown as typeof SAMPLE_MOVE[],
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // К этому моменту прошло 1000ms с initial, но новый таймер только
    // через 500ms — пока ничего не сохранено.
    expect(updateChapterMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Теперь прошло полные 1000ms с rerender'а → один вызов с 2 ходами.
    expect(updateChapterMock).toHaveBeenCalledTimes(1);
    expect(updateChapterMock).toHaveBeenCalledWith('demo', 'ch1', {
      pgn: 'serialized:2',
    });
  });

  it('без auth-токена → skip', () => {
    localStorage.removeItem('token');
    renderHook(() =>
      useStudyChapterPersistence(
        'demo',
        'ch1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [SAMPLE_MOVE] as any,
      ),
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(updateChapterMock).not.toHaveBeenCalled();
  });

  it('без slug → skip', () => {
    renderHook(() =>
      useStudyChapterPersistence(
        undefined,
        'ch1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [SAMPLE_MOVE] as any,
      ),
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(updateChapterMock).not.toHaveBeenCalled();
  });

  it('пустая history + нет initialAnnotations → skip (нечего сохранять)', () => {
    renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useStudyChapterPersistence('demo', 'ch1', [] as any),
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(updateChapterMock).not.toHaveBeenCalled();
  });
});
