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

  /**
   * KS-3261/3262 — диагностика для жалобы пользователя, что lichessGameId
   * якобы не доходит до POST /analyses (запись 8c451a11 в БД с
   * lichess_game_id=NULL). Тесты явно фиксируют контракт body.
   */
  describe('KS-3261 source-IDs in POST body', () => {
    it('lichessGameId передан → попадает в body POST /analyses', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'broadcast-id-1',
      });
      await openAnalysis(navigate, {
        pgn: '1. e4 e5',
        title: 'Deac vs Caruana',
        lichessGameId: '7qKxg3w1',
        includePgnInState: true,
        state: { breadcrumbRootTitle: 'Broadcast' },
      });
      expect(api.post).toHaveBeenCalledTimes(1);
      const [path, body] = (api.post as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(path).toBe('/analyses');
      expect(body).toEqual({
        pgn: '1. e4 e5',
        title: 'Deac vs Caruana',
        category: 'analysis',
        lichessGameId: '7qKxg3w1',
      });
    });

    it('archiveGameId передан → попадает в body POST /analyses', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'archive-id-1',
      });
      await openAnalysis(navigate, {
        pgn: '1. d4 d5',
        title: 'Archive game',
        archiveGameId: 'd99714c9-8903-401e-9e2f-423fc6523b85',
        includePgnInState: true,
      });
      const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(body.archiveGameId).toBe(
        'd99714c9-8903-401e-9e2f-423fc6523b85',
      );
      expect(body.lichessGameId).toBeUndefined();
    });

    it('source-IDs не переданы → body без lichessGameId/archiveGameId', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'plain-1',
      });
      await openAnalysis(navigate, { pgn: '' });
      const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect('lichessGameId' in body).toBe(false);
      expect('archiveGameId' in body).toBe(false);
    });

    it('lichessGameId=undefined → ключ в body отсутствует (не undefined)', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'plain-2',
      });
      await openAnalysis(navigate, {
        pgn: '',
        lichessGameId: undefined,
      });
      const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect('lichessGameId' in body).toBe(false);
    });
  });

  /**
   * KS-3262: existing=true → выкидываем pgn/title из state, добавляем
   * openedExisting. Без этого AnalysisPage инициализирует board из
   * source-pgn (movetext без вариантов).
   */
  describe('KS-3262 existing=true dedup-hit', () => {
    it('existing=true + includePgnInState=true → pgn/title удалены из state, openedExisting=true', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'existing-1',
        existing: true,
      });
      await openAnalysis(navigate, {
        pgn: '1. d4',
        title: 'Deac vs Caruana',
        lichessGameId: '7qKxg3w1',
        includePgnInState: true,
        state: { breadcrumbRootTitle: 'Broadcast' },
      });
      const [path, opts] = (navigate as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(path).toBe('/analysis/existing-1');
      expect(opts.state).toEqual({
        breadcrumbRootTitle: 'Broadcast',
        openedExisting: true,
      });
      expect('pgn' in opts.state).toBe(false);
      expect('title' in opts.state).toBe(false);
    });

    it('existing=false (новый) + includePgnInState=true → pgn/title остаются, openedExisting НЕ ставится', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'new-1',
        existing: false,
      });
      await openAnalysis(navigate, {
        pgn: '1. d4',
        title: 'New game',
        includePgnInState: true,
      });
      const opts = (navigate as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.state.pgn).toBe('1. d4');
      expect(opts.state.title).toBe('New game');
      expect(opts.state.openedExisting).toBeUndefined();
    });

    it('existing field отсутствует → backwards-compat, openedExisting НЕ ставится', async () => {
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'legacy-1',
      });
      await openAnalysis(navigate, {
        pgn: '1. e4',
        includePgnInState: true,
      });
      const opts = (navigate as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.state.openedExisting).toBeUndefined();
      expect(opts.state.pgn).toBe('1. e4');
    });
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
