/**
 * Тесты клиента `batchReviewComment` поверх обработчика
 * `POST /analyses/position/comment` — единичный запрос на позицию,
 * graceful degradation, проброс AbortError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { FactsInput } from '../lib/review/extractFacts';

import { batchReviewComment } from './reviewComment';

function dummyFacts(n: number): FactsInput[] {
  return new Array(n).fill(null).map((_, i) => ({
    ply: i + 1,
    fen: `position-${i + 1}`,
    fen_after: `position-${i + 1}-after`,
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
    positional_subterms: [
      { id: 'outpost_knight', square: 'd5', color: 'w', value_mg: 30, value_eg: 20 },
    ],
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

  it('успешный 200 → массив комментариев по позициям', async () => {
    let call = 0;
    fetchSpy.mockImplementation(async () => {
      const comment = `комментарий ${++call}`;
      return new Response(JSON.stringify({ comment }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const out = await batchReviewComment(dummyFacts(2), 1500, 'ru', undefined, {
      concurrency: 1,
    });
    expect(out).toEqual(['комментарий 1', 'комментарий 2']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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

  it('JSON без поля `comment` → пустая строка', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await batchReviewComment(dummyFacts(2), 1500, 'ru');
    expect(out).toEqual(['', '']);
  });

  it('`comment` не строка → пустая строка', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ comment: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await batchReviewComment(dummyFacts(1), 1500, 'ru');
    expect(out).toEqual(['']);
  });

  it('TypeError (сетевая ошибка) → graceful пустые', async () => {
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

  it('отправляет {fen, factors} на /analyses/position/comment', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ comment: '' }), { status: 200 }),
    );
    await batchReviewComment(dummyFacts(1), 1800, 'en');
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toContain('/analyses/position/comment');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.fen).toBe('position-1');
    expect(Array.isArray(body.factors)).toBe(true);
    expect(body.factors).toHaveLength(1);
    expect(body.factors[0]).toMatchObject({ id: 'outpost_knight' });
    // Старый контракт более не отправляется.
    expect(body.facts).toBeUndefined();
    expect(body.userElo).toBeUndefined();
    expect(body.language).toBeUndefined();
  });
});

// --- Параллельные запросы по позициям ----------------------------------

describe('batchReviewComment — параллелизм и прогресс', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /**
   * Мок: каждый ответ — `c{ply}` для соответствующей позиции. Берём
   * `ply` из тела запроса (через прокидывание fen → распарсенный индекс).
   */
  function mockPerPosition(): void {
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const m = /position-(\d+)/.exec(String(body.fen ?? ''));
      const idx = m ? Number(m[1]) : 0;
      return new Response(JSON.stringify({ comment: `c${idx}` }), {
        status: 200,
      }) as Response;
    });
  }

  it.each([1, 3, 25, 100])(
    'N=%i фактов → N запросов и склейка по индексу позиции',
    async (n) => {
      mockPerPosition();
      const out = await batchReviewComment(dummyFacts(n), 1500, 'ru');
      expect(out).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        expect(out[i]).toBe(`c${i + 1}`);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(n);
    },
  );

  it('частичный сбой одного запроса → остальные доходят, упавший = пустой', async () => {
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const m = /position-(\d+)/.exec(String(body.fen ?? ''));
      const idx = m ? Number(m[1]) : 0;
      if (idx === 2) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ comment: `c${idx}` }), {
        status: 200,
      }) as Response;
    });
    const out = await batchReviewComment(dummyFacts(4), 1500, 'ru', undefined, {
      concurrency: 1,
    });
    expect(out).toEqual(['c1', '', 'c3', 'c4']);
  });

  it('onProgress тикает кумулятивно по каждой завершённой позиции', async () => {
    mockPerPosition();
    const ticks: number[] = [];
    await batchReviewComment(dummyFacts(3), 1500, 'ru', undefined, {
      concurrency: 1,
      onProgress: (done) => ticks.push(done),
    });
    expect(ticks).toEqual([1, 2, 3]);
  });

  it('AbortError в одном запросе → throw наверх (cancel cascade)', async () => {
    const err = new DOMException('aborted', 'AbortError');
    let call = 0;
    fetchSpy.mockImplementation(async () => {
      call++;
      if (call === 2) throw err;
      return new Response(JSON.stringify({ comment: 'x' }), {
        status: 200,
      }) as Response;
    });
    await expect(
      batchReviewComment(dummyFacts(4), 1500, 'ru', undefined, {
        concurrency: 1,
      }),
    ).rejects.toBe(err);
  });

  it('предварительно отменённый signal → AbortError из первого запроса пробрасывается', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    fetchSpy.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      const sig = (init as RequestInit).signal;
      if (sig?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response(JSON.stringify({ comment: '' }), { status: 200 });
    });
    await expect(
      batchReviewComment(dummyFacts(3), 1500, 'ru', ctrl.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
