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
    fen_after:
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
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
    tactical_motifs: [],
    threats_created: {},
    threats_missed: {},
    positional_shifts: [],
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

// --- KS-3629: чанкование -------------------------------------------------

describe('batchReviewComment — чанкование (KS-3629)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /**
   * Хелпер: мокаем fetch так, чтобы каждый вызов возвращал валидный
   * ответ длиной = размеру batch'а в request body. Содержимое каждой
   * строки — `chunk{N}:{i}` где N — порядковый номер вызова fetch.
   */
  function mockChunkedResponses(
    transform: (
      facts: unknown[],
      callIdx: number,
    ) => { status?: number; body?: unknown } = (facts) => ({
      body: {
        comments: (facts as Array<{ ply: number }>).map((f) => `c${f.ply}`),
      },
    }),
  ): void {
    let callIdx = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const r = transform(body.facts, callIdx++);
      const status = r.status ?? 200;
      if (r.body === undefined)
        return new Response('', { status }) as Response;
      return new Response(JSON.stringify(r.body), { status }) as Response;
    });
  }

  it.each([1, 24, 25, 26, 100])(
    'разбивает N=%i фактов на чанки по 25 и склеивает по индексам',
    async (n) => {
      mockChunkedResponses();
      const out = await batchReviewComment(dummyFacts(n), 1500, 'ru');
      expect(out).toHaveLength(n);
      // Все строки должны соответствовать факту по индексу (`ply = i+1`).
      for (let i = 0; i < n; i++) {
        expect(out[i]).toBe(`c${i + 1}`);
      }
      const expectedCalls = Math.ceil(n / 25);
      expect(fetchSpy).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it('кастомный chunkSize — N=10 фактов с chunkSize=4 даёт 3 запроса', async () => {
    mockChunkedResponses();
    const out = await batchReviewComment(dummyFacts(10), 1500, 'ru', undefined, {
      chunkSize: 4,
    });
    expect(out).toHaveLength(10);
    for (let i = 0; i < 10; i++) expect(out[i]).toBe(`c${i + 1}`);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 4+4+2
  });

  it('частичный сбой одного чанка → остальные доходят, упавший = пустые', async () => {
    // 6 фактов, chunkSize=2 → 3 запроса. Второй упадёт 500.
    mockChunkedResponses((facts, callIdx) => {
      if (callIdx === 1) return { status: 500 };
      return {
        body: {
          comments: (facts as Array<{ ply: number }>).map((f) => `c${f.ply}`),
        },
      };
    });
    const out = await batchReviewComment(dummyFacts(6), 1500, 'ru', undefined, {
      chunkSize: 2,
      concurrency: 1, // последовательно, чтобы callIdx был предсказуем
    });
    // chunk 0 (facts 1,2) → ok; chunk 1 (3,4) → 500; chunk 2 (5,6) → ok.
    expect(out).toEqual(['c1', 'c2', '', '', 'c5', 'c6']);
  });

  it('LLM trim: чанк вернул меньше строк → паддинг пустыми в правильных позициях', async () => {
    mockChunkedResponses((facts, callIdx) => {
      if (callIdx === 0) {
        return { body: { comments: ['c1'] } }; // только 1 из 2
      }
      return {
        body: {
          comments: (facts as Array<{ ply: number }>).map((f) => `c${f.ply}`),
        },
      };
    });
    const out = await batchReviewComment(dummyFacts(4), 1500, 'ru', undefined, {
      chunkSize: 2,
      concurrency: 1,
    });
    expect(out).toEqual(['c1', '', 'c3', 'c4']);
  });

  it('onProgress тикает кумулятивно по факту завершения каждого чанка', async () => {
    mockChunkedResponses();
    const ticks: number[] = [];
    await batchReviewComment(dummyFacts(7), 1500, 'ru', undefined, {
      chunkSize: 3,
      concurrency: 1,
      onProgress: (done) => ticks.push(done),
    });
    // 3+3+1 = три тика, кумулятивно
    expect(ticks).toEqual([3, 6, 7]);
  });

  it('AbortError в одном чанке → throw наверх (cancel cascade)', async () => {
    const err = new DOMException('aborted', 'AbortError');
    let callIdx = 0;
    fetchSpy.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 2) throw err;
      return new Response(JSON.stringify({ comments: ['x', 'x'] }), {
        status: 200,
      }) as Response;
    });
    await expect(
      batchReviewComment(dummyFacts(6), 1500, 'ru', undefined, {
        chunkSize: 2,
        concurrency: 1,
      }),
    ).rejects.toBe(err);
  });

  it('signal abort до начала → AbortError из первого fetch пробрасывается', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    fetchSpy.mockImplementation(async (_u, init) => {
      const sig = (init as RequestInit).signal;
      if (sig?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response(JSON.stringify({ comments: [] }), { status: 200 });
    });
    await expect(
      batchReviewComment(dummyFacts(3), 1500, 'ru', ctrl.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('100 фактов проходят без ошибки 400 от ArrayMaxSize (regression KS-3629)', async () => {
    // До чанкования бэк отвергал >40 фактов 400, фронт graceful делал пустые.
    // Теперь — 4 чанка по 25, все 100 строк непустые.
    mockChunkedResponses();
    const out = await batchReviewComment(dummyFacts(100), 1500, 'ru');
    expect(out).toHaveLength(100);
    expect(out.filter((c) => c === '')).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
