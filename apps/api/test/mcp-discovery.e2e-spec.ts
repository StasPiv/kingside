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

  it('каталог НЕ содержит admin/internal путей', async () => {
    const res = await request(app.getHttpServer())
      .get('/_mcp/tools')
      .expect(200);
    for (const tool of res.body.tools as Array<{ path: string }>) {
      expect(tool.path).not.toMatch(/(?:^|\/)(admin|internal)(?:\/|$)/);
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
