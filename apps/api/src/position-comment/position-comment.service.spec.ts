/**
 * KS-3681 / ADR-108 §11 B1. Unit-тесты PositionCommentService.
 *
 * Покрытие:
 *  - buildSystemPrompt: две короткие версии (RU/EN) и дефолт RU при
 *    отсутствии поля `language`.
 *  - comment: при `factors.length === 0` — мгновенный пустой ответ
 *    без обращения к webhook'у (early-return, ADR-108 §5.3).
 *  - comment: при наличии факторов — webhook вызывается, получает
 *    инструкцию в нужной локали.
 *  - graceful degradation: webhook не настроен → пустой ответ.
 *
 * Webhook'овые вызовы делаются через глобальный `fetch` — мокаем
 * `global.fetch` напрямую. RedisService — stub (не задействован
 * в этих тестах, т.к. rate-limit вызывается из контроллера).
 */
import { ConfigService } from '@nestjs/config';
import { PositionCommentService } from './position-comment.service';
import type { PositionCommentDto } from './dto/position-comment.dto';

type ConfigMap = Record<string, string>;

function makeConfigService(values: ConfigMap = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      values[key] !== undefined ? values[key] : fallback,
  } as unknown as ConfigService;
}

function makeRedisStub() {
  return {
    get: jest.fn(async () => null),
    set: jest.fn(),
    pipeline: jest.fn(() => ({
      incr: () => ({} as any),
      expire: () => ({} as any),
      exec: async () => [],
    })),
  } as any;
}

function makeDto(overrides: Partial<PositionCommentDto> = {}): PositionCommentDto {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    factors: [{ id: 'material', color: 'w', value_mg: 0.34, value_eg: 0.19 }],
    ...overrides,
  };
}

describe('PositionCommentService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('buildSystemPrompt (KS-3681 / ADR-108 §8.2)', () => {
    const svc = new PositionCommentService(
      makeConfigService({}),
      makeRedisStub(),
    );

    it('RU при вызове без аргумента — дефолт', () => {
      expect(svc.buildSystemPrompt()).toBe(
        'Прокомментируй пожалуйста позицию человеческим языком на основании факторов',
      );
    });

    it('RU при явном language=ru', () => {
      expect(svc.buildSystemPrompt('ru')).toBe(
        'Прокомментируй пожалуйста позицию человеческим языком на основании факторов',
      );
    });

    it('EN при language=en', () => {
      expect(svc.buildSystemPrompt('en')).toBe(
        'Please comment on this chess position in plain language using the given positional factors',
      );
    });

    it('обе версии — одна короткая фраза без обучающих примеров и калибровки', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p.length).toBeLessThan(200);
        expect(p).not.toContain('CRITICAL RULES');
        expect(p).not.toContain('FORBIDDEN');
        expect(p).not.toContain('ЗАПРЕЩЕНО');
        expect(p).not.toContain('few-shot');
      }
    });
  });

  describe('comment — пустой factors (KS-3681 / ADR-108 §5.3)', () => {
    it('factors=[] → возвращает "" без вызова webhook', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;

      const result = await svc.comment(
        'user-1',
        makeDto({ factors: [] }),
      );
      expect(result).toBe('');
      expect(spy).not.toHaveBeenCalled();
    });

    it('factors=[] и без webhookUrl → тоже возвращает "" без вызова', async () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;

      const result = await svc.comment(
        'user-1',
        makeDto({ factors: [] }),
      );
      expect(result).toBe('');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('comment — webhook получает инструкцию в нужной локали', () => {
    it('language=en → systemPrompt в payload — EN', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ response: 'comment text' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      const result = await svc.comment(
        'user-1',
        makeDto({ language: 'en' }),
      );
      expect(result).toBe('comment text');
      expect(captured.systemPrompt).toBe(
        'Please comment on this chess position in plain language using the given positional factors',
      );
    });

    it('language=ru → systemPrompt в payload — RU', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ response: 'комментарий' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      await svc.comment('user-1', makeDto({ language: 'ru' }));
      expect(captured.systemPrompt).toBe(
        'Прокомментируй пожалуйста позицию человеческим языком на основании факторов',
      );
    });

    it('без поля language → RU (backward-compat)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ response: 'комментарий' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      const dto = makeDto();
      delete dto.language;
      await svc.comment('user-1', dto);
      expect(captured.systemPrompt).toBe(
        'Прокомментируй пожалуйста позицию человеческим языком на основании факторов',
      );
    });
  });

  describe('comment — graceful degradation', () => {
    it('webhookUrl пуст → возвращает "" без обращения', async () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;
      const result = await svc.comment('user-1', makeDto());
      expect(result).toBe('');
      expect(spy).not.toHaveBeenCalled();
    });

    it('webhook 5xx → пустая строка', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = jest.fn(async () =>
        new Response('upstream broken', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      ) as any;
      const result = await svc.comment('user-1', makeDto());
      expect(result).toBe('');
    });
  });
});
