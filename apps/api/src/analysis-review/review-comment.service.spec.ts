/**
 * KS-3615 / ADR-102 §8 B. Unit-тесты ReviewCommentService.
 *
 * Webhook'овые вызовы делаются через глобальный `fetch` — мокаем
 * `global.fetch` напрямую, без http-моков. RedisService — stub.
 */
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReviewCommentService } from './review-comment.service';
import type { BatchCommentDto } from './dto/batch-comment.dto';

type ConfigMap = Record<string, string>;

function makeConfigService(values: ConfigMap = {}): ConfigService {
  // ConfigService.get<T>(key, defaultValue) — мы используем второй
  // аргумент как fallback, поэтому моковый get должен его учитывать.
  return {
    get: (key: string, fallback?: unknown) =>
      values[key] !== undefined ? values[key] : fallback,
  } as unknown as ConfigService;
}

function makeRedisStub() {
  const store = new Map<string, string>();
  const pipelineOps: Array<() => void> = [];
  const pipeline = {
    incr: (k: string) => {
      pipelineOps.push(() => {
        const v = parseInt(store.get(k) ?? '0', 10) + 1;
        store.set(k, String(v));
      });
      return pipeline;
    },
    expire: (_k: string, _s: number) => {
      // no-op для теста
      return pipeline;
    },
    exec: async () => {
      for (const op of pipelineOps) op();
      pipelineOps.length = 0;
      return [];
    },
  };
  return {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    pipeline: jest.fn(() => pipeline),
    _store: store,
  } as any;
}

function makeFacts(n: number): BatchCommentDto {
  const facts = Array.from({ length: n }, (_, i) => ({
    ply: i,
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    side: 'white' as const,
    move: {
      san: `m${i}`,
      uci: 'e2e4',
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion: null,
    },
    classification: 'mistake' as const,
    delta_e: -0.2,
    sf_best: null,
    maia_alternative: null,
    stage: 'middlegame' as const,
    opening_name: null,
    material_balance: 0,
    material_change: null,
    hanging_piece: null,
    mate_threat_after: null,
    user_elo: 1500,
    user_language: 'en' as const,
  }));
  return { facts, userElo: 1500, language: 'en' };
}

describe('ReviewCommentService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('batchComment — graceful degradation', () => {
    it('webhook URL не задан → массив пустых строк той же длины', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({}), // AI_CHAT_WEBHOOK_URL пустой
        makeRedisStub(),
      );
      const dto = makeFacts(3);
      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['', '', '']);
    });

    it('успешный response → распарсенные строки', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(2);
      global.fetch = jest.fn(async () =>
        new Response(
          JSON.stringify({ response: '["First comment.", "Second comment."]' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['First comment.', 'Second comment.']);
    });

    it('webhook 5xx → массив пустых строк, не падаем', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(3);
      global.fetch = jest.fn(async () =>
        new Response('upstream broken', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['', '', '']);
    });

    it('webhook 200, но невалидный JSON в response → массив пустых строк', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(2);
      global.fetch = jest.fn(async () =>
        new Response(
          JSON.stringify({ response: 'не json вообще' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['', '']);
    });

    it('длина response-массива не совпадает с expected → массив пустых строк', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(3);
      global.fetch = jest.fn(async () =>
        new Response(
          JSON.stringify({ response: '["only one"]' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['', '', '']);
    });

    it('fetch throws (network error) → массив пустых строк', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(1);
      global.fetch = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['']);
    });

    it('webhook 200, response с markdown-фенсом → парсится корректно', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(2);
      const fenced =
        '```json\n["From a code block.", "Second."]\n```';
      global.fetch = jest.fn(async () =>
        new Response(JSON.stringify({ response: fenced }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual(['From a code block.', 'Second.']);
    });
  });

  describe('buildSystemPrompt — содержит все CRITICAL RULES', () => {
    const svc = new ReviewCommentService(
      makeConfigService({}),
      makeRedisStub(),
    );

    it('содержит CRITICAL RULES блок и язык', () => {
      const p = svc.buildSystemPrompt('ru', 1500);
      expect(p).toContain('User language: ru');
      expect(p).toContain('CRITICAL RULES:');
      expect(p).toContain('DO NOT invent tactical motifs');
      expect(p).toContain('DO NOT make subjective evaluations');
      expect(p).toContain('DO NOT mention engine evaluations in centipawns');
      expect(p).toContain('hanging_piece');
      expect(p).toContain('maia_alternative');
      expect(p).toContain('JSON array of strings');
    });

    it('калибровка под ELO: <1500 → simple, ≥2000 → technical, иначе intermediate', () => {
      expect(svc.buildSystemPrompt('en', 1000)).toContain('Use simple terms.');
      expect(svc.buildSystemPrompt('en', 1700)).toContain(
        'Use intermediate terms.',
      );
      expect(svc.buildSystemPrompt('en', 2200)).toContain(
        'Use technical terms.',
      );
    });
  });

  describe('parseAndValidate — детали парсера', () => {
    const svc = new ReviewCommentService(
      makeConfigService({}),
      makeRedisStub(),
    );

    it('snimaet ```json``` fence', () => {
      const raw = '```json\n["a", "b"]\n```';
      expect(svc.parseAndValidate(raw, 2)).toEqual(['a', 'b']);
    });

    it('snimaet plain ``` fence', () => {
      const raw = '```\n["a"]\n```';
      expect(svc.parseAndValidate(raw, 1)).toEqual(['a']);
    });

    it('извлекает массив из текста с префиксом', () => {
      const raw = 'Here are the comments: ["one", "two"]';
      expect(svc.parseAndValidate(raw, 2)).toEqual(['one', 'two']);
    });

    it('пустая строка → throw', () => {
      expect(() => svc.parseAndValidate('', 2)).toThrow();
    });

    it('не массив → throw', () => {
      expect(() => svc.parseAndValidate('{"a":1}', 1)).toThrow();
    });

    it('массив с не-строкой → throw', () => {
      expect(() => svc.parseAndValidate('["ok", 42]', 2)).toThrow();
    });

    it('массив другой длины → throw', () => {
      expect(() => svc.parseAndValidate('["a", "b", "c"]', 2)).toThrow();
    });
  });

  describe('rate-limit', () => {
    it('checkRateLimit пропускает первый запрос, бросает 429 после превышения per-min', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({
          AI_CHAT_WEBHOOK_URL: 'http://wh.test',
          REVIEW_COMMENT_RATE_LIMIT_PER_MIN: '2',
          REVIEW_COMMENT_RATE_LIMIT_PER_DAY: '100',
          REVIEW_COMMENT_GLOBAL_DAILY_LIMIT: '1000',
        }),
        makeRedisStub(),
      );

      // 1-й и 2-й проходят
      await expect(svc.checkRateLimit('u-1')).resolves.toBeUndefined();
      await svc.incrementRateLimit('u-1');
      await expect(svc.checkRateLimit('u-1')).resolves.toBeUndefined();
      await svc.incrementRateLimit('u-1');
      // 3-й — превышение
      await expect(svc.checkRateLimit('u-1')).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('namespace отделён от чата (review:* vs chat:*)', async () => {
      const redis = makeRedisStub();
      const svc = new ReviewCommentService(
        makeConfigService({
          AI_CHAT_WEBHOOK_URL: 'http://wh.test',
          REVIEW_COMMENT_RATE_LIMIT_PER_MIN: '5',
        }),
        redis,
      );
      await svc.incrementRateLimit('u-7');
      // Под review:rate:min:u-7 счётчик = 1, под chat:* — отсутствует.
      const reviewKey = 'review:rate:min:u-7';
      const chatKey = 'chat:rate:min:u-7';
      expect(redis._store.get(reviewKey)).toBe('1');
      expect(redis._store.get(chatKey)).toBeUndefined();
    });
  });
});
