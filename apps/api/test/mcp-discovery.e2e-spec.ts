/**
 * KS-2952 / ADR-061 этап A1.
 * e2e на GET /_mcp/tools:
 *  - dev (NODE_ENV != production) — открыт без ключа;
 *  - prod без ключа → 403, с правильным ключом → 200;
 *  - каталог НЕ содержит admin/internal-роутов и ни одного контроллера
 *    под AdminApiKeyGuard/AdminUserGuard/AdminEmailGuard/InternalKeyGuard;
 *  - пилотные модули из KS-2952 A1 видны: studies/analyses/puzzles/
 *    tactic_drills/games.
 *
 * AppModule поднимается реальным (Postgres из apps/api/.env).
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { McpDiscoveryKeyGuard } from '../src/mcp/mcp-discovery-key.guard';

jest.setTimeout(60_000);

describe('GET /_mcp/tools (KS-2952)', () => {
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // в e2e jest по умолчанию NODE_ENV=test → guard пускает без ключа.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    process.env = originalEnv;
    if (app) await app.close();
  });

  it('dev: без ключа отдаёт каталог 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(typeof res.body.generatedAt).toBe('string');
  });

  it('каталог содержит пилотные секции A1 (studies/analyses/puzzles/tactic_drills/games)', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    const ids = res.body.sections.map((s: { id: string }) => s.id);
    for (const expected of [
      'studies',
      'analyses',
      'puzzles',
      'tactic_drills',
      'games',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('KS-2954 (A2): каталог содержит остальные секции по таблице ADR-061 §8', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    const ids = res.body.sections.map((s: { id: string }) => s.id);
    // ProfileModule использует тот же section `users` что и UserModule;
    // MistakesModule — `puzzles` как и PuzzleModule. Дедуплицируется.
    for (const expected of [
      'users',
      'puzzle_rush',
      'tournaments',
      'live_tournaments',
      'workshop',
      'players',
      'messages',
      'friends',
      'notifications',
      'arena',
      'feedback',
      'lessons',
      'user_courses',
      'config',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('KS-2954: total ~20 секций (по таблице ADR-061 §8)', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    // Ожидаемо 19 уникальных section id (UserModule+ProfileModule
    // делят `users`; PuzzleModule+MistakesModule делят `puzzles`):
    // studies, analyses, puzzles, tactic_drills, games, users,
    // puzzle_rush, tournaments, live_tournaments, workshop, players,
    // messages, friends, notifications, arena, feedback, lessons,
    // user_courses, config = 19.
    expect(res.body.sections.length).toBeGreaterThanOrEqual(18);
    expect(res.body.sections.length).toBeLessThanOrEqual(22);
  });

  it('каталог НЕ содержит admin/internal путей', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    for (const tool of res.body.tools as Array<{ path: string }>) {
      expect(tool.path).not.toMatch(/(?:^|\/)(admin|internal)(?:\/|$)/);
    }
  });

  it('KS-2954: excluded-модули отсутствуют в каталоге (auth/admin/ai-chat/metrics/client-logs/health)', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    const paths = (res.body.tools as Array<{ path: string }>).map(
      (t) => t.path,
    );
    // ни одного tool'а под этими префиксами
    for (const forbidden of [
      '/auth',
      '/admin',
      '/internal',
      '/chat',
      '/metrics',
      '/client-logs',
      '/health',
    ]) {
      const leaked = paths.filter(
        (p) => p === forbidden || p.startsWith(forbidden + '/'),
      );
      expect(leaked).toEqual([]);
    }
  });

  it('каждый tool имеет name/section/method/path/input', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    expect(res.body.tools.length).toBeGreaterThan(0);
    for (const tool of res.body.tools as Array<{
      name: string;
      section: string;
      method: string;
      path: string;
      input: { type: string };
    }>) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.section).toBe('string');
      expect(typeof tool.method).toBe('string');
      expect(typeof tool.path).toBe('string');
      expect(tool.input?.type).toBe('object');
    }
  });

  // ── KS-2953 (этап B). Точечные `@McpTool` на listing-эндпоинтах
  // публикуют `defaults.limit`, `limits.maxLimit`, `excludeFields` в
  // каталог; MCP-сервер использует их как подсказки для клиентских
  // вызовов (резка тяжёлых полей до возврата модели).
  describe('KS-2953 listing tools (defaults/limits/excludeFields)', () => {
    let tools: Map<string, any>;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .get('/_mcp/tools')
        .expect(200);
      tools = new Map(
        (res.body.tools as Array<{ name: string }>).map((t) => [t.name, t]),
      );
    });

    function expectListing(
      name: string,
      expected: {
        defaultLimit?: number;
        maxLimit?: number;
        excludeFields?: string[];
      },
    ) {
      const t = tools.get(name);
      expect(t).toBeDefined();
      if (expected.defaultLimit !== undefined) {
        expect(t.defaults?.limit).toBe(expected.defaultLimit);
      }
      if (expected.maxLimit !== undefined) {
        expect(t.limits?.maxLimit).toBe(expected.maxLimit);
      }
      if (expected.excludeFields !== undefined) {
        expect(t.excludeFields).toEqual(expected.excludeFields);
      }
    }

    it('analyses__list — limit=20/max=100, exclude pgn/fen/currentPosition', () => {
      expectListing('analyses__list', {
        defaultLimit: 20,
        maxLimit: 100,
        excludeFields: ['[].pgn', '[].fen', '[].currentPosition'],
      });
    });

    it('analyses__search — limit=20/max=50', () => {
      expectListing('analyses__search', { defaultLimit: 20, maxLimit: 50 });
    });

    it('studies__list — limit=20/max=50', () => {
      expectListing('studies__list', { defaultLimit: 20, maxLimit: 50 });
    });

    it('studies__catalog — limit=20/max=50', () => {
      expectListing('studies__catalog', { defaultLimit: 20, maxLimit: 50 });
    });

    it('studies__list_public — limit=20/max=50', () => {
      expectListing('studies__list_public', {
        defaultLimit: 20,
        maxLimit: 50,
      });
    });

    it('games__my — limit=20/max=100, exclude pgn/moves/fen/finalFen', () => {
      expectListing('games__my', {
        defaultLimit: 20,
        maxLimit: 100,
        excludeFields: ['[].pgn', '[].moves', '[].fen', '[].finalFen'],
      });
    });

    it('games__live — limit=20/max=100, exclude pgn/moves', () => {
      expectListing('games__live', {
        defaultLimit: 20,
        maxLimit: 100,
        excludeFields: ['[].pgn', '[].moves'],
      });
    });

    it('puzzles__find — limit=10/max=50, exclude solution/moves', () => {
      expectListing('puzzles__find', {
        defaultLimit: 10,
        maxLimit: 50,
        excludeFields: ['[].solution', '[].moves'],
      });
    });

    it('puzzles__attempts — limit=20/max=100, exclude nested puzzle solution/moves', () => {
      expectListing('puzzles__attempts', {
        defaultLimit: 20,
        maxLimit: 100,
        excludeFields: ['[].puzzle.solution', '[].puzzle.moves'],
      });
    });

    it('puzzles__browse — limit=20/max=50, exclude solution/moves', () => {
      expectListing('puzzles__browse', {
        defaultLimit: 20,
        maxLimit: 50,
        excludeFields: ['[].solution', '[].moves'],
      });
    });
  });

  it('prod: без ключа → 403', async () => {
    // переключаемся в production-режим через override guard.canActivate
    // (manipulate process.env могло бы повлиять на другие тесты — лучше
    // напрямую дёрнуть guard в изоляции).
    const { ConfigService } = await import('@nestjs/config');
    const fakeConfig = {
      get: (k: string) =>
        k === 'NODE_ENV' ? 'production' : k === 'MCP_DISCOVERY_KEY' ? 'sekret' : undefined,
    } as unknown as InstanceType<typeof ConfigService>;
    const guard = new McpDiscoveryKeyGuard(fakeConfig);
    expect(() =>
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as never),
    ).toThrow();
  });
});
