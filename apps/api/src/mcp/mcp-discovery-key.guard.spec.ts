/**
 * KS-2952 / ADR-061 §5 lvl 5 + §6, ослаблено в KS-3218.
 * Юнит-тесты McpDiscoveryKeyGuard:
 *  - dev (NODE_ENV != production) → пускает всех;
 *  - prod **без** MCP_DISCOVERY_KEY → пускает (no-op, /_mcp/tools публичен);
 *  - prod + ключ задан + правильный заголовок → ок;
 *  - prod + ключ задан + неверный/отсутствующий заголовок → 403.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  McpDiscoveryKeyGuard,
  MCP_DISCOVERY_HEADER,
} from './mcp-discovery-key.guard';

function ctxWithHeader(value: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { [MCP_DISCOVERY_HEADER]: value } }),
    }),
  } as unknown as ExecutionContext;
}

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('McpDiscoveryKeyGuard (KS-2952)', () => {
  it('dev: NODE_ENV=test → allow без ключа', () => {
    const g = new McpDiscoveryKeyGuard(makeConfig({ NODE_ENV: 'test' }));
    expect(g.canActivate(ctxWithHeader(undefined))).toBe(true);
  });

  // KS-3218: ослабление — env не задан → guard no-op (раньше было 403).
  it('prod без MCP_DISCOVERY_KEY → allow (KS-3218 ослабление, /_mcp/tools публичен)', () => {
    const g = new McpDiscoveryKeyGuard(
      makeConfig({ NODE_ENV: 'production', MCP_DISCOVERY_KEY: '' }),
    );
    expect(g.canActivate(ctxWithHeader('xxx'))).toBe(true);
    expect(g.canActivate(ctxWithHeader(undefined))).toBe(true);
  });

  it('prod без MCP_DISCOVERY_KEY (env вообще отсутствует) → allow', () => {
    const g = new McpDiscoveryKeyGuard(
      makeConfig({ NODE_ENV: 'production' /* MCP_DISCOVERY_KEY undefined */ }),
    );
    expect(g.canActivate(ctxWithHeader(undefined))).toBe(true);
  });

  it('prod + правильный ключ → allow', () => {
    const g = new McpDiscoveryKeyGuard(
      makeConfig({ NODE_ENV: 'production', MCP_DISCOVERY_KEY: 'secret' }),
    );
    expect(g.canActivate(ctxWithHeader('secret'))).toBe(true);
  });

  it('prod + неверный ключ → 403', () => {
    const g = new McpDiscoveryKeyGuard(
      makeConfig({ NODE_ENV: 'production', MCP_DISCOVERY_KEY: 'secret' }),
    );
    expect(() => g.canActivate(ctxWithHeader('wrong'))).toThrow(
      ForbiddenException,
    );
  });

  it('prod без заголовка → 403', () => {
    const g = new McpDiscoveryKeyGuard(
      makeConfig({ NODE_ENV: 'production', MCP_DISCOVERY_KEY: 'secret' }),
    );
    expect(() => g.canActivate(ctxWithHeader(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('prod + ключ другой длины → 403 (timingSafeEqual защита)', () => {
    const g = new McpDiscoveryKeyGuard(
      makeConfig({ NODE_ENV: 'production', MCP_DISCOVERY_KEY: 'longerkey' }),
    );
    expect(() => g.canActivate(ctxWithHeader('short'))).toThrow(
      ForbiddenException,
    );
  });
});
