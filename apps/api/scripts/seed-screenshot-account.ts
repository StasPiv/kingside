/**
 * KS-2257 (ADR-036 §3, screenshot tooling E2).
 *
 * Идемпотентный seed для технического аккаунта `__screenshot_agent`,
 * который используется screenshot-tooling'ом (KS-2253 / E3+) для
 * скриптовой авторизации в UI и снятия скриншотов разделов прода без
 * dev-bypass.
 *
 * Поведение:
 *   1. Читает пароль из env `SCRN_AGENT_PASSWORD`. Если не задан или
 *      пустая строка — `runSeedScreenshotAccount()` бросает Error,
 *      обёртка main() ловит и выходит с кодом 1 (без записи в БД).
 *   2. Upsert по `username = '__screenshot_agent'`:
 *      - create: новый юзер с `isTestAccount=true`, `isHidden=true`,
 *        `passwordHash = bcrypt(SCRN_AGENT_PASSWORD)`, `requiresUsernameSetup=false`.
 *      - update: обновляет `passwordHash` (на случай ротации пароля),
 *        проставляет `isTestAccount=true / isHidden=true` (на случай,
 *        если флаги случайно сняли руками), оставляет остальные поля.
 *   3. **Без админских прав.** Гард `AdminUserGuard` берёт whitelist
 *      из ENV `KS_ADMIN_USERS` — username сюда **не вносить**.
 *
 * Запуск:
 *   - локально:        SCRN_AGENT_PASSWORD=... npm run seed:screenshot --workspace=@kingside/api
 *   - на проде (ECS):  one-off task `kingside-api:seed-screenshot` (ECS RunTask),
 *                      см. apps/api/scripts/README.md.
 *
 * Идемпотентность: повторный запуск с тем же паролем — обновит
 * `passwordHash` (bcrypt-соль новая каждый раз, hash будет другим, но
 * аутентификация работает). Запуск без `SCRN_AGENT_PASSWORD` — fail-fast.
 */

import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@kingside/db';

export const SCREENSHOT_AGENT_USERNAME = '__screenshot_agent';
export const SCREENSHOT_AGENT_EMAIL = '__screenshot_agent@kingside.local';
const BCRYPT_ROUNDS = 10;

/**
 * Минимальный интерфейс над `prisma.user`, который требует seed.
 * Сужен до `findUnique`/`upsert`, чтобы тест мог подсунуть фейк
 * без полной типизации `PrismaClient`.
 */
type SeedPrisma = {
  user: {
    findUnique: (args: {
      where: { username: string };
      select: Record<string, boolean>;
    }) => Promise<unknown>;
    upsert: (args: {
      where: { username: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<{
      id: string;
      username: string;
      isTestAccount: boolean;
      isHidden: boolean;
    }>;
  };
};

export interface SeedResult {
  action: 'created' | 'updated';
  user: {
    id: string;
    username: string;
    isTestAccount: boolean;
    isHidden: boolean;
  };
}

/**
 * Чистая функция: принимает уже инстанцированную `prisma` и password,
 * возвращает `SeedResult`. Бросает Error для невалидных входов и
 * наружу пробрасывает любые DB-ошибки. Этот же entry-point использует
 * `seed-screenshot-account.spec.ts`.
 */
export async function runSeedScreenshotAccount(
  prisma: SeedPrisma,
  password: string | undefined,
): Promise<SeedResult> {
  if (!password || password.length === 0) {
    throw new Error('SCRN_AGENT_PASSWORD env not set or empty');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const before = await prisma.user.findUnique({
    where: { username: SCREENSHOT_AGENT_USERNAME },
    select: { id: true, isTestAccount: true, isHidden: true },
  });

  const user = await prisma.user.upsert({
    where: { username: SCREENSHOT_AGENT_USERNAME },
    // Повторный запуск перепрошьёт passwordHash и принудительно вернёт
    // isTestAccount=true / isHidden=true.
    update: {
      passwordHash,
      isTestAccount: true,
      isHidden: true,
    },
    create: {
      username: SCREENSHOT_AGENT_USERNAME,
      email: SCREENSHOT_AGENT_EMAIL,
      passwordHash,
      isTestAccount: true,
      isHidden: true,
      requiresUsernameSetup: false,
    },
    select: {
      id: true,
      username: true,
      isTestAccount: true,
      isHidden: true,
    },
  });

  return { action: before ? 'updated' : 'created', user };
}

/**
 * CLI-обёртка. Запускается из `npm run seed:screenshot`.
 * Не вызывается во время `import` (см. защиту `require.main === module`),
 * чтобы тестовый файл мог импортировать `runSeedScreenshotAccount`
 * без побочных эффектов.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await runSeedScreenshotAccount(
      prisma as unknown as SeedPrisma,
      process.env.SCRN_AGENT_PASSWORD,
    );
    process.stdout.write(
      `✓ seed-screenshot-account: ${result.action} user ` +
        `${result.user.username} (id=${result.user.id}, ` +
        `isTestAccount=${result.user.isTestAccount}, ` +
        `isHidden=${result.user.isHidden})\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`✗ seed-screenshot-account: ${msg}\n`);
    process.exit(1);
  });
}
