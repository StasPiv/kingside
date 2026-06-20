/**
 * KS-4456 / ADR-139 T4. Юнит-тесты CLI `service-account.cli`.
 *
 * Цели:
 *   * Формат генерируемого токена (`ks_sa_` + 32 url-safe base64).
 *   * Sha256 — детерминирован, в БД попадает только hash, не plain.
 *   * Duplicate handle на create → ошибка с подсказкой про rotate.
 *   * `revoke` идемпотентен (повторный вызов не падает, info-сообщение).
 *   * `rotate` обнуляет `revokedAt` и пишет новый hash.
 *   * `parseArgs` — таблица случаев.
 *
 * Prisma подменён фабрикой `makePrisma()`; реальная БД не дёргается.
 */
import { createHash } from 'node:crypto';
import {
  generatePlainToken,
  parseArgs,
  runCreate,
  runList,
  runRevoke,
  runRotate,
  SaPrisma,
} from './service-account.cli';
import { SERVICE_ACCOUNT_PREFIX } from '../auth/service-account.guard';

function sha256(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

interface FakeRow {
  id: string;
  handle: string;
  description: string | null;
  tokenHash: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function makePrisma(initial: FakeRow[] = []): {
  prisma: SaPrisma;
  store: FakeRow[];
  spies: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
} {
  const store: FakeRow[] = [...initial];
  const spies = {
    findUnique: jest.fn((args: { where: { handle: string } }) => {
      return Promise.resolve(
        store.find((r) => r.handle === args.where.handle) ?? null,
      );
    }),
    findMany: jest.fn(() => Promise.resolve([...store])),
    create: jest.fn((args: { data: Omit<FakeRow, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'> }) => {
      const row: FakeRow = {
        id: `id-${store.length + 1}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
        ...args.data,
      };
      store.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      (args: { where: { handle: string }; data: Partial<FakeRow> }) => {
        const idx = store.findIndex((r) => r.handle === args.where.handle);
        if (idx === -1) {
          return Promise.reject(new Error('not found'));
        }
        store[idx] = { ...store[idx], ...args.data };
        return Promise.resolve(store[idx]);
      },
    ),
  };
  const prisma: SaPrisma = {
    agentServiceAccount: {
      findUnique: spies.findUnique as unknown as SaPrisma['agentServiceAccount']['findUnique'],
      findMany: spies.findMany as unknown as SaPrisma['agentServiceAccount']['findMany'],
      create: spies.create as unknown as SaPrisma['agentServiceAccount']['create'],
      update: spies.update as unknown as SaPrisma['agentServiceAccount']['update'],
    },
  };
  return { prisma, store, spies };
}

describe('generatePlainToken', () => {
  it('начинается с префикса ks_sa_', () => {
    const t = generatePlainToken();
    expect(t.startsWith(SERVICE_ACCOUNT_PREFIX)).toBe(true);
  });

  it('случайная часть — 32 base64url-символа (24 байта)', () => {
    const t = generatePlainToken();
    const raw = t.slice(SERVICE_ACCOUNT_PREFIX.length);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('два вызова дают разные токены (рандом из crypto.randomBytes)', () => {
    const a = generatePlainToken();
    const b = generatePlainToken();
    expect(a).not.toEqual(b);
  });
});

describe('parseArgs', () => {
  it('пустой argv → command=help', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('неизвестная команда → help', () => {
    expect(parseArgs(['flush']).command).toBe('help');
  });

  it('create --handle agent-1 --scope blog:write --scope lessons:read', () => {
    const a = parseArgs([
      'create',
      '--handle',
      'agent-1',
      '--scope',
      'blog:write',
      '--scope',
      'lessons:read',
    ]);
    expect(a.command).toBe('create');
    expect(a.handle).toBe('agent-1');
    expect(a.scopes).toEqual(['blog:write', 'lessons:read']);
  });

  it('поддерживает форму --key=value', () => {
    const a = parseArgs([
      'create',
      '--handle=agent-2',
      '--description=Bot account',
      '--scope=blog:*',
    ]);
    expect(a.handle).toBe('agent-2');
    expect(a.description).toBe('Bot account');
    expect(a.scopes).toEqual(['blog:*']);
  });

  it('revoke --handle agent-1', () => {
    const a = parseArgs(['revoke', '--handle', 'agent-1']);
    expect(a.command).toBe('revoke');
    expect(a.handle).toBe('agent-1');
  });

  it('list без аргументов', () => {
    const a = parseArgs(['list']);
    expect(a.command).toBe('list');
    expect(a.handle).toBeUndefined();
  });

  it('rotate --handle agent-1', () => {
    const a = parseArgs(['rotate', '--handle', 'agent-1']);
    expect(a.command).toBe('rotate');
    expect(a.handle).toBe('agent-1');
  });

  it('неизвестный флаг игнорируется', () => {
    const a = parseArgs(['create', '--handle', 'x', '--ttl', '7d']);
    expect(a.handle).toBe('x');
  });
});

describe('runCreate', () => {
  it('создаёт запись + возвращает plain (показывается один раз)', async () => {
    const { prisma, store, spies } = makePrisma();
    const lines: string[] = [];
    const res = await runCreate(
      prisma,
      { handle: 'agent-x', description: 'desc', scopes: ['blog:write'] },
      (l) => lines.push(l),
    );
    expect(res.handle).toBe('agent-x');
    expect(res.plain.startsWith(SERVICE_ACCOUNT_PREFIX)).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0].tokenHash).toBe(sha256(res.plain));
    expect(store[0].scopes).toEqual(['blog:write']);
    expect(store[0].description).toBe('desc');
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes(res.plain))).toBe(true);
    expect(lines.some((l) => l.includes('один раз') || l.includes('ОДИН раз'))).toBe(true);
  });

  it('plain в БД не сохраняется (только sha256)', async () => {
    const { prisma, store } = makePrisma();
    const res = await runCreate(
      prisma,
      { handle: 'a', scopes: [] },
      () => {},
    );
    expect(store[0].tokenHash).not.toEqual(res.plain);
    expect(store[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handle уже существует → ошибка с подсказкой rotate', async () => {
    const { prisma } = makePrisma([
      {
        id: 'id-0',
        handle: 'dup',
        description: null,
        tokenHash: 'xxx',
        scopes: [],
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    await expect(
      runCreate(prisma, { handle: 'dup', scopes: [] }, () => {}),
    ).rejects.toThrow(/rotate/);
  });

  it('пустой handle → ошибка', async () => {
    const { prisma } = makePrisma();
    await expect(
      runCreate(prisma, { handle: '', scopes: [] }, () => {}),
    ).rejects.toThrow(/handle/);
  });

  it('description undefined → null в БД', async () => {
    const { prisma, store } = makePrisma();
    await runCreate(prisma, { handle: 'a', scopes: [] }, () => {});
    expect(store[0].description).toBeNull();
  });
});

describe('runList', () => {
  it('пустой список → сообщение «Сервисных аккаунтов нет»', async () => {
    const { prisma } = makePrisma();
    const lines: string[] = [];
    const rows = await runList(prisma, (l) => lines.push(l));
    expect(rows).toEqual([]);
    expect(lines).toContain('Сервисных аккаунтов нет.');
  });

  it('выводит handle/scopes/createdAt/lastUsedAt/revokedAt без plain-токена', async () => {
    const { prisma } = makePrisma([
      {
        id: 'id-1',
        handle: 'agent-a',
        description: null,
        tokenHash: 'hash-secret-12345',
        scopes: ['blog:write'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: new Date('2026-01-02T00:00:00Z'),
        revokedAt: null,
      },
    ]);
    const lines: string[] = [];
    await runList(prisma, (l) => lines.push(l));
    const joined = lines.join('\n');
    expect(joined).toContain('agent-a');
    expect(joined).toContain('blog:write');
    expect(joined).toContain('2026-01-01');
    expect(joined).not.toContain('hash-secret');
    expect(joined).not.toContain('ks_sa_');
  });
});

describe('runRevoke', () => {
  it('активный аккаунт → выставляет revokedAt', async () => {
    const { prisma, store } = makePrisma([
      {
        id: 'id-1',
        handle: 'agent-a',
        description: null,
        tokenHash: 'h',
        scopes: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    const res = await runRevoke(prisma, { handle: 'agent-a' }, () => {});
    expect(res.alreadyRevoked).toBe(false);
    expect(store[0].revokedAt).toBeInstanceOf(Date);
  });

  it('уже отозванный аккаунт → не падает, alreadyRevoked=true', async () => {
    const revokedAt = new Date('2026-01-01T00:00:00Z');
    const { prisma, store, spies } = makePrisma([
      {
        id: 'id-1',
        handle: 'agent-a',
        description: null,
        tokenHash: 'h',
        scopes: [],
        createdAt: new Date('2025-12-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt,
      },
    ]);
    const lines: string[] = [];
    const res = await runRevoke(prisma, { handle: 'agent-a' }, (l) => lines.push(l));
    expect(res.alreadyRevoked).toBe(true);
    expect(store[0].revokedAt).toBe(revokedAt);
    expect(spies.update).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('уже отозван'))).toBe(true);
  });

  it('handle не найден → ошибка', async () => {
    const { prisma } = makePrisma();
    await expect(
      runRevoke(prisma, { handle: 'ghost' }, () => {}),
    ).rejects.toThrow(/не найден/);
  });

  it('пустой handle → ошибка', async () => {
    const { prisma } = makePrisma();
    await expect(
      runRevoke(prisma, { handle: '' }, () => {}),
    ).rejects.toThrow(/handle/);
  });
});

describe('runRotate', () => {
  it('обновляет tokenHash + обнуляет revokedAt', async () => {
    const oldHash = sha256('old');
    const { prisma, store } = makePrisma([
      {
        id: 'id-1',
        handle: 'agent-a',
        description: null,
        tokenHash: oldHash,
        scopes: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ]);
    const res = await runRotate(prisma, { handle: 'agent-a' }, () => {});
    expect(res.plain.startsWith(SERVICE_ACCOUNT_PREFIX)).toBe(true);
    expect(store[0].tokenHash).toBe(sha256(res.plain));
    expect(store[0].tokenHash).not.toBe(oldHash);
    expect(store[0].revokedAt).toBeNull();
  });

  it('handle не найден → ошибка', async () => {
    const { prisma } = makePrisma();
    await expect(
      runRotate(prisma, { handle: 'ghost' }, () => {}),
    ).rejects.toThrow(/не найден/);
  });

  it('пустой handle → ошибка', async () => {
    const { prisma } = makePrisma();
    await expect(
      runRotate(prisma, { handle: '' }, () => {}),
    ).rejects.toThrow(/handle/);
  });

  it('новый plain отличается от рандома предыдущего вызова', async () => {
    const { prisma } = makePrisma([
      {
        id: 'id-1',
        handle: 'agent-a',
        description: null,
        tokenHash: 'h',
        scopes: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    const a = await runRotate(prisma, { handle: 'agent-a' }, () => {});
    const b = await runRotate(prisma, { handle: 'agent-a' }, () => {});
    expect(a.plain).not.toBe(b.plain);
  });
});
