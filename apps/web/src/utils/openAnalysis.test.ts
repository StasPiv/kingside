import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavigateFunction } from 'react-router-dom';

import { openAnalysis } from './openAnalysis';

/**
 * KS-2603 (ADR-051 §4 B1): unit-тест helper'а `openAnalysis` —
 * 3 режима + error-path. Запросы изолируем через `vi.mock('../api')`,
 * navigate подменяем `vi.fn()` (не нужен реальный React Router в этом
 * тесте — helper принимает любой `NavigateFunction`-совместимый callback).
 */

vi.mock('../api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../api';

describe('openAnalysis (KS-2603)', () => {
  // `NavigateFunction` — overloaded, vi.fn() выводится несовместимо.
  // Кастуем через unknown — для теста достаточно функции с любой подписью.
  let navigate: NavigateFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate = vi.fn() as unknown as NavigateFunction &
      ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('режим 1 (existingId): navigate без POST', async () => {
    await openAnalysis(navigate, { existingId: 'abc-123' });
    expect(api.post).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/analysis/abc-123', {
      state: {},
    });
  });

  it('режим 1 (existingId) с replace+state', async () => {
    await openAnalysis(navigate, {
      existingId: 'abc-123',
      replace: true,
      state: { breadcrumbRootTitle: 'Lessons' },
    });
    expect(navigate).toHaveBeenCalledWith('/analysis/abc-123', {
      state: { breadcrumbRootTitle: 'Lessons' },
      replace: true,
    });
  });

  it('режим 2 (pgn непустой): POST + navigate, pgn НЕ в state по умолчанию', async () => {
    // KS-2605: по умолчанию pgn/title в state не передаются —
    // AnalysisPage подгружает по id через GET /analyses/:id.
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'new-id-1',
    });
    await openAnalysis(navigate, {
      pgn: '1. e4 e5',
      title: 'My game',
      state: { breadcrumbRootTitle: 'Archive' },
    });
    expect(api.post).toHaveBeenCalledWith('/analyses', {
      pgn: '1. e4 e5',
      title: 'My game',
      category: 'analysis',
    });
    expect(navigate).toHaveBeenCalledWith('/analysis/new-id-1', {
      state: { breadcrumbRootTitle: 'Archive' },
    });
  });

  it('режим 2 с includePgnInState: true (legacy back-compat): pgn/title в state', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'new-id-legacy',
    });
    await openAnalysis(navigate, {
      pgn: '1. e4 e5',
      title: 'My game',
      state: { breadcrumbRootTitle: 'Archive' },
      includePgnInState: true,
    });
    expect(navigate).toHaveBeenCalledWith('/analysis/new-id-legacy', {
      state: {
        breadcrumbRootTitle: 'Archive',
        pgn: '1. e4 e5',
        title: 'My game',
      },
    });
  });

  it('режим 2 (pgn пустой): POST {pgn:""} + navigate без pgn в state', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'new-empty-1',
    });
    await openAnalysis(navigate, { pgn: '' });
    expect(api.post).toHaveBeenCalledWith('/analyses', {
      pgn: '',
      title: 'New analysis',
      category: 'analysis',
    });
    expect(navigate).toHaveBeenCalledWith('/analysis/new-empty-1', {
      state: {},
    });
  });

  it('режим 2 без аргументов: эквивалент «свободный анализ»', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'new-empty-2',
    });
    await openAnalysis(navigate);
    expect(api.post).toHaveBeenCalledWith('/analyses', {
      pgn: '',
      title: 'New analysis',
      category: 'analysis',
    });
    expect(navigate).toHaveBeenCalledWith('/analysis/new-empty-2', {
      state: {},
    });
  });

  it('error: POST падает → onError вызывается, navigate НЕ вызывается', async () => {
    const onError = vi.fn();
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network failed'),
    );
    // Глушим console.error чтобы не засорять вывод теста.
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await openAnalysis(navigate, {
      pgn: '1. e4',
      title: 'Test',
      onError,
    });

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'Could not open analysis. Please try again.',
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('error: t-функция используется для локализованного сообщения', async () => {
    const onError = vi.fn();
    const t = vi.fn(
      (_key: string, _defaultValue: string) =>
        'Не удалось открыть анализ. Попробуйте ещё раз.',
    );
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await openAnalysis(navigate, { onError, t });

    expect(t).toHaveBeenCalledWith(
      'analysis.openError',
      'Could not open analysis. Please try again.',
    );
    expect(onError).toHaveBeenCalledWith(
      'Не удалось открыть анализ. Попробуйте ещё раз.',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('error: дефолтный onError — window.alert', async () => {
    // jsdom в vitest по умолчанию не определяет `window.alert` —
    // навешиваем как обычное property, потом восстанавливаем undefined.
    const originalAlert = (window as unknown as { alert?: unknown }).alert;
    const alertSpy = vi.fn();
    (window as unknown as { alert: typeof alertSpy }).alert = alertSpy;
    try {
      (api.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('boom'),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await openAnalysis(navigate, { pgn: '' });

      expect(alertSpy).toHaveBeenCalledWith(
        'Could not open analysis. Please try again.',
      );
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      (window as unknown as { alert: unknown }).alert = originalAlert as unknown;
    }
  });
});
