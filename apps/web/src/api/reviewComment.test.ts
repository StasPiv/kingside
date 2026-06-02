/**
 * KS-3616. Тесты клиента `batchReviewComment` — graceful degradation
 * и проброс AbortError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { FactsInput } from '../lib/review/extractFacts';

import { batchReviewComment } from './reviewComment';

function dummyFacts(n: number): FactsInput[] {
  return new Array(n).fill(null).map((_, i) => ({
    ply: i + 1,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    side: 'white',
    move: {
      san: 'e4',
      uci: 'e2e4',
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion: null,
      en_passant: false,
    },
    classification: 'good',
    delta_e: 0,
    sf_best: null,
    maia_alternative: null,
    stage: 'opening',
    opening_name: null,
    material_balance: 0,
    material_change: null,
    hanging_piece: null,
    mate_threat_after: null,
    user_elo: 1500,
    user_language: 'ru',
  }));
}

describe('batchReviewComment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('пустой массив → пустой ответ без сетевого вызова', async () => {
    const out = await batchReviewComment([], 1500, 'ru');
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('успешный 200 → массив комментариев', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ comments: ['Хороший ход', 'Слабее, чем Nf3'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const out = await batchReviewComment(dummyFacts(2), 1500, 'ru');
    expect(out).toEqual(['Хороший ход', 'Слабее, чем Nf3']);
  });

  it('500 → массив пустых строк длиной = facts.length (graceful)', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    const out = await batchReviewComment(dummyFacts(3), 1500, 'ru');
    expect(out).toEqual(['', '', '']);
  });

  it('429 → graceful пустые', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Too Many Requests', { status: 429 }),
    );
    const out = await batchReviewComment(dummyFacts(2), 1500, 'en');
    expect(out).toEqual(['', '']);
  });

  it('невалидный JSON в ответе → graceful пустые', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not-json{{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await batchReviewComment(dummyFacts(2), 1500, 'ru');
    expect(out).toEqual(['', '']);
  });

  it('JSON без поля `comments` → graceful пустые', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await batchReviewComment(dummyFacts(2), 1500, 'ru');
    expect(out).toEqual(['', '']);
  });

  it('comments[i] не строка → пустая строка', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ comments: ['ok', null, 42, 'last'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await batchReviewComment(dummyFacts(4), 1500, 'ru');
    expect(out).toEqual(['ok', '', '', 'last']);
  });

  it('TypeError (network failure) → graceful пустые', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await batchReviewComment(dummyFacts(2), 1500, 'ru');
    expect(out).toEqual(['', '']);
  });

  it('AbortError → throw', async () => {
    const err = new DOMException('aborted', 'AbortError');
    fetchSpy.mockRejectedValue(err);
    await expect(batchReviewComment(dummyFacts(1), 1500, 'ru')).rejects.toBe(
      err,
    );
  });

  it('передаёт facts/userElo/language в body', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ comments: [''] }), { status: 200 }),
    );
    await batchReviewComment(dummyFacts(1), 1800, 'en');
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toContain('/analyses/review/comments');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.userElo).toBe(1800);
    expect(body.language).toBe('en');
    expect(Array.isArray(body.facts)).toBe(true);
    expect(body.facts).toHaveLength(1);
  });
});
