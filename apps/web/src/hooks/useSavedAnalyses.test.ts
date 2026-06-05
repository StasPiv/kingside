import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSavedAnalyses } from './useSavedAnalyses';

vi.mock('../api', () => ({
  api: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

const apiMock = (await import('../api')).api as unknown as {
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('KS-3724: useSavedAnalyses.create передаёт fen в POST /analyses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.post.mockResolvedValue({ id: 'a1' });
  });

  it('без fen — поле в body не отправляется (back-compat)', async () => {
    const { result } = renderHook(() => useSavedAnalyses());
    await act(async () => {
      await result.current.create('1. e4', 'My analysis', 'analysis');
    });
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.post.mock.calls[0];
    expect(body).toMatchObject({
      pgn: '1. e4',
      title: 'My analysis',
      category: 'analysis',
    });
    expect(body).not.toHaveProperty('fen');
  });

  it('с fen — поле уходит в body, чтобы бэк положил его в analyses.fen', async () => {
    const { result } = renderHook(() => useSavedAnalyses());
    const fen = '1k6/8/8/8/8/8/8/1K6 w - - 0 1';
    await act(async () => {
      await result.current.create('', 'New analysis', 'analysis', fen);
    });
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.post.mock.calls[0];
    expect(body).toMatchObject({
      pgn: '',
      title: 'New analysis',
      category: 'analysis',
      fen,
    });
  });
});
