/**
 * KS-3712. Тесты `postMoveComment` — атомарный запрос на
 * `POST /analyses/review/move-comment`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { postMoveComment, type MoveCommentRequest } from './moveComment';

const REQUEST: MoveCommentRequest = {
  move: {
    san: 'e5',
    uci: 'e7e5',
    capture: null,
    check: false,
    mate: null,
    castling: null,
    promotion: null,
    classification: 'blunder',
  },
  before: {
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    factors: [{ id: 'space', value_mg: 0.1, value_eg: 0 }],
  },
  after: {
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
    factors: [{ id: 'space', value_mg: 0.1, value_eg: 0 }],
  },
  language: 'ru',
};

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('postMoveComment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', 'jwt-test');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('успешный ответ → возвращает comment', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ comment: 'Слабый ход' }));
    const out = await postMoveComment(REQUEST);
    expect(out).toBe('Слабый ход');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/analyses/review/move-comment');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.move.uci).toBe('e7e5');
    expect(body.before.fen).toContain(' b ');
    expect(body.after.fen).toContain(' w ');
    expect(body.language).toBe('ru');
  });

  it('5xx → пустая строка', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 502 }));
    const out = await postMoveComment(REQUEST);
    expect(out).toBe('');
  });

  it('не-JSON body → пустая строка', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const out = await postMoveComment(REQUEST);
    expect(out).toBe('');
  });

  it('сетевой сбой → пустая строка', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await postMoveComment(REQUEST);
    expect(out).toBe('');
  });

  it('AbortError → пробрасывается наружу', async () => {
    fetchSpy.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(postMoveComment(REQUEST)).rejects.toBeInstanceOf(DOMException);
  });

  it('Authorization-заголовок ставится из localStorage', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ comment: 'ok' }));
    await postMoveComment(REQUEST);
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-test');
  });
});
