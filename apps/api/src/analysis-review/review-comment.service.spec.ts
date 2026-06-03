/**
 * KS-3615 / ADR-102 §8 B (MVP-1) + KS-3625 / ADR-103 rev 3 §7/§8
 * (MVP-2 B1'). Unit-тесты ReviewCommentService.
 *
 * Сервис stateless: серверного Stockfish нет (отменён в rev 3 — eval
 * полностью уехал на клиент). Тесты покрывают:
 *  - graceful degradation webhook'а;
 *  - V1 prompt (default — REVIEW_COMMENT_V2 off);
 *  - V2 prompt (few-shot, запреты, ELO-калибровка);
 *  - postValidate (NAG-blacklist + min-length, активна в ОБЕИХ ветках);
 *  - rate-limit (namespace review:*).
 *
 * Webhook'овые вызовы делаются через глобальный `fetch` — мокаем
 * `global.fetch` напрямую, без http-моков. RedisService — stub.
 */
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReviewCommentService } from './review-comment.service';
import type { BatchCommentDto, MoveFactsDto } from './dto/batch-comment.dto';

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
  const facts: MoveFactsDto[] = Array.from({ length: n }, (_, i) => ({
    ply: i,
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    fen_after: '8/8/8/8/8/8/8/8 b - - 0 1',
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
    tactical_motifs: [],
    threats_created: {},
    threats_missed: {},
    positional_shifts: [],
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
          JSON.stringify({
            response:
              '["First long enough comment about the move.", "Another lengthy explanation here."]',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual([
        'First long enough comment about the move.',
        'Another lengthy explanation here.',
      ]);
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
        '```json\n["From a code block long enough comment.", "Second comment with enough words inside."]\n```';
      global.fetch = jest.fn(async () =>
        new Response(JSON.stringify({ response: fenced }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as any;

      const result = await svc.batchComment('user-1', dto);
      expect(result).toEqual([
        'From a code block long enough comment.',
        'Second comment with enough words inside.',
      ]);
    });
  });

  describe('buildSystemPrompt V1 (default — REVIEW_COMMENT_V2 off)', () => {
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

    it('isV2Enabled() === false при дефолтном ENV', () => {
      expect(svc.isV2Enabled()).toBe(false);
    });

    it('V1 prompt НЕ содержит V2-специфичных блоков (regression)', () => {
      const p = svc.buildSystemPrompt('ru', 1500);
      expect(p).not.toContain('ЗАПРЕЩЕНО');
      expect(p).not.toContain('few-shot');
      expect(p).not.toContain('positional_shifts');
      expect(p).not.toContain('tactical_motifs');
    });
  });

  describe('buildSystemPrompt V2 (REVIEW_COMMENT_V2=on)', () => {
    const svc = new ReviewCommentService(
      makeConfigService({ REVIEW_COMMENT_V2: 'on' }),
      makeRedisStub(),
    );

    it('isV2Enabled() === true', () => {
      expect(svc.isV2Enabled()).toBe(true);
    });

    it('RU prompt содержит запрет NAG-тавтологии и few-shot маркеры', () => {
      const p = svc.buildSystemPrompt('ru', 1500);
      expect(p).toContain('User language: ru');
      expect(p).toContain('ЗАПРЕЩЕНО');
      expect(p).toContain('«сильный ход»');
      expect(p).toContain('positional_shifts');
      expect(p).toContain('tactical_motifs');
      expect(p).toContain('threats_created');
      // Few-shot пары
      expect(p).toContain('ПЛОХО');
      expect(p).toContain('ХОРОШО');
      // должны быть оба вида примеров — RU и EN — для устойчивости
      expect(p).toContain('BAD');
      expect(p).toContain('GOOD');
    });

    it('EN prompt содержит запрет NAG-тавтологии и few-shot маркеры', () => {
      const p = svc.buildSystemPrompt('en', 1500);
      expect(p).toContain('User language: en');
      expect(p).toContain('FORBIDDEN');
      expect(p).toContain('"strong move"');
      expect(p).toContain('BAD');
      expect(p).toContain('GOOD');
    });

    it('ELO калибровка переключает подсказку лексики', () => {
      expect(svc.buildSystemPrompt('ru', 1200)).toContain('Простые слова');
      expect(svc.buildSystemPrompt('ru', 2100)).toContain(
        'Позиционные термины',
      );
      expect(svc.buildSystemPrompt('en', 1200)).toContain('Simple words');
      expect(svc.buildSystemPrompt('en', 2100)).toContain('Positional terms');
    });

    it('Few-shot содержит минимум 8 базовых ADR-103 пар + 5 ADR-107 (KS-3651)', () => {
      const p = svc.buildSystemPrompt('en', 1500);
      // Каждая пара = одна BAD-строка. Считаем число BAD: в EN-блоке.
      const badCount = (p.match(/^BAD:/gm) ?? []).length;
      const plohoCount = (p.match(/^ПЛОХО:/gm) ?? []).length;
      // 8 базовых ADR-103 + 5 новых под subterm (KS-3651) = 13 пар
      // в каждом из RU/EN блоков (оба блока всегда подаются вместе).
      expect(badCount).toBeGreaterThanOrEqual(13);
      expect(plohoCount).toBeGreaterThanOrEqual(13);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // KS-3651 / ADR-107 rev 2 §6. Prompt V2 учит модель использовать
  // `positional_subterms` (PSQT/mobility/king-attackers и др.).
  // pruneUnknownSubterms terplikt unknown id с WARN.
  // ─────────────────────────────────────────────────────────────────
  describe('KS-3651 positional_subterms (V2 prompt + pruneUnknownSubterms)', () => {
    const svc = new ReviewCommentService(
      makeConfigService({ REVIEW_COMMENT_V2: 'on' }),
      makeRedisStub(),
    );

    it('V2 RU prompt описывает positional_subterms (название поля + правило дедупликации)', () => {
      const p = svc.buildSystemPrompt('ru', 1500);
      expect(p).toContain('positional_subterms');
      expect(p).toMatch(/плохой слон|форпост/);
      expect(p).toContain('Дедупликация');
    });

    it('V2 EN prompt описывает positional_subterms + deduplication rule', () => {
      const p = svc.buildSystemPrompt('en', 1500);
      expect(p).toContain('positional_subterms');
      expect(p).toMatch(/bad bishop|outpost/);
      expect(p).toContain('Deduplication');
    });

    it('V2 prompt содержит few-shot пары с ключевыми subterm-ID (KS-3651 acceptance)', () => {
      const p = svc.buildSystemPrompt('en', 1500);
      // Координатор просил BishopPawns, Outpost, RookOnOpenFile,
      // ShelterStrength, PassedRank — все должны быть в EN-блоке few-shot.
      expect(p).toContain('"bishop_pawns"');
      expect(p).toContain('"outpost_knight"');
      expect(p).toContain('"rook_on_open_file"');
      expect(p).toContain('"king_shelter_strength"');
      expect(p).toContain('"passed_rank"');
    });

    it('pruneUnknownSubterms: известные id сохраняются, неизвестные отбрасываются', () => {
      const dto = makeFacts(1);
      dto.facts[0].positional_subterms = [
        {
          id: 'outpost_knight',
          color: 'w',
          square: 'd5',
          value_mg: 0.16,
          value_eg: 0.1,
        },
        {
          id: 'totally_made_up_id',
          color: 'b',
          square: 'a1',
          value_mg: 0.0,
          value_eg: 0.0,
        },
        {
          id: 'bishop_pawns',
          color: 'w',
          square: 'h2',
          value_mg: -0.07,
          value_eg: -0.21,
        },
      ];
      const pruned = svc.pruneUnknownSubterms(dto.facts);
      expect(pruned[0].positional_subterms).toHaveLength(2);
      expect(pruned[0].positional_subterms?.map((s) => s.id)).toEqual([
        'outpost_knight',
        'bishop_pawns',
      ]);
    });

    it('pruneUnknownSubterms: пустой/отсутствующий массив остаётся как есть', () => {
      const dto = makeFacts(2);
      // Первый факт — нет positional_subterms вообще; второй — пустой массив.
      dto.facts[1].positional_subterms = [];
      const pruned = svc.pruneUnknownSubterms(dto.facts);
      expect(pruned[0].positional_subterms).toBeUndefined();
      expect(pruned[1].positional_subterms).toEqual([]);
    });

    it('pruneUnknownSubterms: при наличии unknown id логируется WARN с aggregated counts', () => {
      const warnSpy = jest
        .spyOn((svc as any).logger, 'warn')
        .mockImplementation(() => {});
      const dto = makeFacts(1);
      dto.facts[0].positional_subterms = [
        { id: 'fake_a', value_mg: 0, value_eg: 0 },
        { id: 'fake_b', value_mg: 0, value_eg: 0 },
      ];
      svc.pruneUnknownSubterms(dto.facts);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain('dropped 2 unknown subterm-id(s)');
      expect(msg).toContain('fake_a');
      expect(msg).toContain('fake_b');
    });

    it('pruneUnknownSubterms: только известные id → WARN не логируется', () => {
      const warnSpy = jest
        .spyOn((svc as any).logger, 'warn')
        .mockImplementation(() => {});
      const dto = makeFacts(1);
      dto.facts[0].positional_subterms = [
        {
          id: 'pawn_isolated',
          color: 'w',
          square: 'd4',
          value_mg: -0.003,
          value_eg: -0.061,
        },
      ];
      svc.pruneUnknownSubterms(dto.facts);
      expect(warnSpy).not.toHaveBeenCalled();
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

  describe('postValidate — NAG-blacklist и min-length (ADR-103 §8)', () => {
    const svc = new ReviewCommentService(
      makeConfigService({}),
      makeRedisStub(),
    );

    it('NAG RU: «Сильный ход.» → пустая строка', () => {
      expect(svc.postValidate(['Сильный ход.'])).toEqual(['']);
      expect(svc.postValidate(['сильный ход'])).toEqual(['']);
      expect(svc.postValidate(['Грубая ошибка!'])).toEqual(['']);
      expect(svc.postValidate(['Неточность.'])).toEqual(['']);
      expect(svc.postValidate(['Зевок'])).toEqual(['']);
    });

    it('NAG EN: «Mistake.» / «Blunder» → пустая строка', () => {
      expect(svc.postValidate(['Mistake.'])).toEqual(['']);
      expect(svc.postValidate(['Blunder!'])).toEqual(['']);
      expect(svc.postValidate(['Good move.'])).toEqual(['']);
      expect(svc.postValidate(['Inaccuracy'])).toEqual(['']);
    });

    it('Короткий комментарий (<4 слов И <25 символов) → пустая строка', () => {
      expect(svc.postValidate(['Очень кратко.'])).toEqual(['']);
      expect(svc.postValidate(['Too short'])).toEqual(['']);
    });

    it('Содержательный комментарий проходит', () => {
      const ok =
        'Ферзь становится под удар коня f6 без защиты — теряется фигура.';
      expect(svc.postValidate([ok])).toEqual([ok]);
    });

    it('Длинный по символам (≥25) но мало слов — проходит', () => {
      // 3 слова, но 30+ символов → правило (минимум слов ИЛИ символов).
      const s = 'Aaaaaaaa bbbbbbbb ccccccccccccccc';
      expect(s.length).toBeGreaterThanOrEqual(25);
      expect(svc.postValidate([s])).toEqual([s]);
    });

    it('Пустая строка остаётся пустой (валидно — модель сама вернула пустоту)', () => {
      expect(svc.postValidate([''])).toEqual(['']);
    });

    it('postValidate активна и при V2=off', () => {
      // Тот же сервис без REVIEW_COMMENT_V2 — всё равно режет NAG.
      const v1 = new ReviewCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      expect(v1.isV2Enabled()).toBe(false);
      expect(v1.postValidate(['Strong move.'])).toEqual(['']);
    });

    it('postValidate применяется поверх parseAndValidate в batchComment', async () => {
      const svc = new ReviewCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const dto = makeFacts(2);
      // Модель вернула одну NAG-тавтологию и один содержательный — после
      // post-валидации NAG превратится в пустую строку.
      global.fetch = jest.fn(async () =>
        new Response(
          JSON.stringify({
            response:
              '["Strong move.", "The knight grabs the pawn and forks queen and rook."]',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.batchComment('u', dto);
      expect(result).toEqual([
        '',
        'The knight grabs the pawn and forks queen and rook.',
      ]);
    });

    it('Кастомные пороги MIN_WORDS/MIN_CHARS уважаются', () => {
      const svc = new ReviewCommentService(
        makeConfigService({
          REVIEW_COMMENT_MIN_WORDS: '6',
          REVIEW_COMMENT_MIN_CHARS: '40',
        }),
        makeRedisStub(),
      );
      // 5 слов, 30 символов — не пройдёт ни по словам (<6), ни по символам (<40).
      expect(svc.postValidate(['One two three four five.'])).toEqual(['']);
      // 6 слов — проходит.
      expect(svc.postValidate(['One two three four five six.'])).toEqual([
        'One two three four five six.',
      ]);
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
