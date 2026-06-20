/**
 * KS-4456 / ADR-139 T4. CLI для управления сервисными аккаунтами
 * автономных агентов (`AgentServiceAccount`, T1 KS-4453).
 *
 * Команды:
 *   create  --handle <h> [--description "<text>"] [--scope blog:write] [--scope ...]
 *   list
 *   revoke  --handle <h>
 *   rotate  --handle <h>
 *
 * Формат токена: `ks_sa_<32 url-safe base64>` (24 случайных байта →
 * 32 base64url-символа). 24 байта = 192 бита энтропии — на порядок
 * больше типичной требуемой для API-токенов длины.
 *
 * Plain показывается ОДИН раз: на create / rotate. В БД хранится
 * только `sha256(plain)`. Потерял plain — единственный путь
 * восстановления — rotate.
 *
 * Запуск:
 *   - локально:  `npm run service-account --workspace=@kingside/api -- create --handle agent-backend`
 *   - на проде:  ECS RunTask `node dist/scripts/service-account.cli.js create ...`
 *     (по той же схеме, что seed-blog / publish-critical-moment).
 */
import { PrismaClient } from '@kingside/db';
import { randomBytes } from 'node:crypto';
import { sha256Hex, SERVICE_ACCOUNT_PREFIX } from '../auth/service-account.guard';

/** 24 байта → 32 base64url-символа (≈192 бит энтропии). */
const TOKEN_RANDOM_BYTES = 24;

export interface SaPrisma {
  agentServiceAccount: {
    findUnique: (args: unknown) => Promise<unknown>;
    findMany: (args?: unknown) => Promise<unknown[]>;
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  $disconnect?: () => Promise<void>;
}

export function generatePlainToken(): string {
  const raw = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
  return `${SERVICE_ACCOUNT_PREFIX}${raw}`;
}

export interface ParsedArgs {
  command: 'create' | 'list' | 'revoke' | 'rotate' | 'help';
  handle?: string;
  description?: string;
  scopes: string[];
  rawFlags: string[];
}

/**
 * Простой парсер argv для CLI. Поддерживает `--key value` и `--key=value`
 * + повторяющийся `--scope` (массив). Без зависимостей вроде yargs —
 * для четырёх команд хватает.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [rawCmd, ...rest] = argv;
  const cmd = (rawCmd ?? 'help').toLowerCase();
  const result: ParsedArgs = {
    command: ['create', 'list', 'revoke', 'rotate', 'help'].includes(cmd)
      ? (cmd as ParsedArgs['command'])
      : 'help',
    scopes: [],
    rawFlags: rest,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    let key: string;
    let value: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : undefined;
      }
    } else {
      continue;
    }
    switch (key) {
      case 'handle':
        result.handle = value;
        break;
      case 'description':
        result.description = value;
        break;
      case 'scope':
        if (value) result.scopes.push(value);
        break;
      default:
        // Игнорируем неизвестные флаги — облегчает обратную совместимость,
        // ошибочные опечатки заметит сам пользователь через `--help`.
        break;
    }
  }
  return result;
}

// ─── команды ────────────────────────────────────────────────────────

export async function runCreate(
  prisma: SaPrisma,
  args: { handle: string; description?: string; scopes: string[] },
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<{ handle: string; plain: string }> {
  if (!args.handle) {
    throw new Error('--handle обязателен для create');
  }
  const existing = await prisma.agentServiceAccount.findUnique({
    where: { handle: args.handle },
  });
  if (existing) {
    throw new Error(
      `Сервисный аккаунт handle="${args.handle}" уже существует. Используй rotate для смены токена.`,
    );
  }
  const plain = generatePlainToken();
  const tokenHash = sha256Hex(plain);
  await prisma.agentServiceAccount.create({
    data: {
      handle: args.handle,
      description: args.description ?? null,
      tokenHash,
      scopes: args.scopes,
    },
  });
  log(`Сервисный аккаунт создан: handle=${args.handle}`);
  log(`Scopes: ${args.scopes.length > 0 ? args.scopes.join(', ') : '(пусто)'}`);
  log('');
  log('⚠️  Токен показан ОДИН раз. Скопируй сейчас:');
  log(`    ${plain}`);
  return { handle: args.handle, plain };
}

interface AccountRow {
  handle: string;
  description: string | null;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function runList(
  prisma: SaPrisma,
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<AccountRow[]> {
  const rows = (await prisma.agentServiceAccount.findMany({
    orderBy: { handle: 'asc' },
    select: {
      handle: true,
      description: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  })) as AccountRow[];
  if (rows.length === 0) {
    log('Сервисных аккаунтов нет.');
    return rows;
  }
  log('HANDLE                         | SCOPES                       | CREATED              | LAST USED            | REVOKED');
  log('-------------------------------+------------------------------+----------------------+----------------------+--------');
  for (const r of rows) {
    const scopes = r.scopes.length > 0 ? r.scopes.join(',') : '-';
    log(
      [
        r.handle.padEnd(30),
        scopes.padEnd(28),
        r.createdAt.toISOString(),
        (r.lastUsedAt?.toISOString() ?? '-').padEnd(20),
        r.revokedAt ? r.revokedAt.toISOString() : '-',
      ].join(' | '),
    );
  }
  return rows;
}

export async function runRevoke(
  prisma: SaPrisma,
  args: { handle: string },
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<{ handle: string; alreadyRevoked: boolean }> {
  if (!args.handle) {
    throw new Error('--handle обязателен для revoke');
  }
  const existing = (await prisma.agentServiceAccount.findUnique({
    where: { handle: args.handle },
    select: { handle: true, revokedAt: true },
  })) as { handle: string; revokedAt: Date | null } | null;
  if (!existing) {
    throw new Error(`Сервисный аккаунт handle="${args.handle}" не найден`);
  }
  if (existing.revokedAt) {
    log(`Аккаунт handle="${args.handle}" уже отозван (revokedAt=${existing.revokedAt.toISOString()})`);
    return { handle: args.handle, alreadyRevoked: true };
  }
  await prisma.agentServiceAccount.update({
    where: { handle: args.handle },
    data: { revokedAt: new Date() },
  });
  log(`Сервисный аккаунт handle="${args.handle}" отозван.`);
  return { handle: args.handle, alreadyRevoked: false };
}

export async function runRotate(
  prisma: SaPrisma,
  args: { handle: string },
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<{ handle: string; plain: string }> {
  if (!args.handle) {
    throw new Error('--handle обязателен для rotate');
  }
  const existing = await prisma.agentServiceAccount.findUnique({
    where: { handle: args.handle },
    select: { handle: true },
  });
  if (!existing) {
    throw new Error(`Сервисный аккаунт handle="${args.handle}" не найден`);
  }
  const plain = generatePlainToken();
  const tokenHash = sha256Hex(plain);
  await prisma.agentServiceAccount.update({
    where: { handle: args.handle },
    data: { tokenHash, revokedAt: null },
  });
  log(`Токен сервисного аккаунта handle="${args.handle}" ротирован.`);
  log('Старый токен инвалидирован немедленно.');
  log('');
  log('⚠️  Новый токен показан ОДИН раз. Скопируй сейчас:');
  log(`    ${plain}`);
  return { handle: args.handle, plain };
}

function printHelp(log: (line: string) => void): void {
  log('Использование: node dist/scripts/service-account.cli.js <command> [args]');
  log('');
  log('Команды:');
  log('  create  --handle <h> [--description "<text>"] [--scope blog:write] [--scope ...]');
  log('  list');
  log('  revoke  --handle <h>');
  log('  rotate  --handle <h>');
  log('');
  log('Примеры:');
  log('  service-account create --handle agent-backend --description "Backend agent" --scope blog:write');
  log('  service-account list');
  log('  service-account revoke --handle agent-backend');
  log('  service-account rotate --handle agent-backend');
}

export async function main(
  argv: string[] = process.argv.slice(2),
  prismaFactory: () => SaPrisma = () =>
    new PrismaClient() as unknown as SaPrisma,
): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    printHelp((l) => process.stdout.write(`${l}\n`));
    return;
  }
  const prisma = prismaFactory();
  try {
    switch (args.command) {
      case 'create':
        await runCreate(prisma, {
          handle: args.handle ?? '',
          description: args.description,
          scopes: args.scopes,
        });
        break;
      case 'list':
        await runList(prisma);
        break;
      case 'revoke':
        await runRevoke(prisma, { handle: args.handle ?? '' });
        break;
      case 'rotate':
        await runRotate(prisma, { handle: args.handle ?? '' });
        break;
    }
  } finally {
    await prisma.$disconnect?.();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `✗ service-account fatal: ${(e as Error).message}\n`,
    );
    process.exit(1);
  });
}
