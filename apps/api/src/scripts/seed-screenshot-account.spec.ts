/**
 * KS-2257: контракт `runSeedScreenshotAccount`.
 *
 * Тестируем чистую функцию (без CLI-обёртки и реального PrismaClient):
 *   - fail-fast если password пустой/undefined
 *   - первый запуск (юзера нет) → create + лог "created"
 *   - повторный запуск (юзер есть) → update-ветка + лог "updated"
 *   - DB-ошибки пробрасываются наружу
 *
 * `bcrypt.hash` мокаем — иначе тест медленный и зависит от рандомной
 * соли (для контракта достаточно знать, что в `passwordHash` приходит
 * результат `bcrypt.hash(input, ...)`).
 */

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

import {
  runSeedScreenshotAccount,
  SCREENSHOT_AGENT_USERNAME,
  SCREENSHOT_AGENT_EMAIL,
} from './seed-screenshot-account';

function makePrisma(initial: { exists: boolean }) {
  const upsert = jest.fn().mockResolvedValue({
    id: initial.exists ? 'uuid-existing' : 'uuid-new',
    username: SCREENSHOT_AGENT_USERNAME,
    isTestAccount: true,
    isHidden: true,
  });
  const findUnique = jest
    .fn()
    .mockResolvedValue(
      initial.exists
        ? { id: 'uuid-existing', isTestAccount: true, isHidden: true }
        : null,
    );
  return {
    prisma: { user: { findUnique, upsert } },
    upsert,
    findUnique,
  };
}

describe('runSeedScreenshotAccount (KS-2257)', () => {
  it('пустой password → throws, upsert не вызывается', async () => {
    const { prisma, upsert } = makePrisma({ exists: false });
    await expect(runSeedScreenshotAccount(prisma, '')).rejects.toThrow(
      /SCRN_AGENT_PASSWORD env not set or empty/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('undefined password → throws, upsert не вызывается', async () => {
    const { prisma, upsert } = makePrisma({ exists: false });
    await expect(
      runSeedScreenshotAccount(prisma, undefined),
    ).rejects.toThrow(/SCRN_AGENT_PASSWORD env not set or empty/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('первый запуск (юзера нет) → action=created, create-ветка с isTestAccount/isHidden', async () => {
    const { prisma, upsert } = makePrisma({ exists: false });

    const result = await runSeedScreenshotAccount(prisma, 'pwd-2026');

    expect(result.action).toBe('created');
    expect(result.user.isTestAccount).toBe(true);
    expect(result.user.isHidden).toBe(true);

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ username: SCREENSHOT_AGENT_USERNAME });
    expect(call.create).toMatchObject({
      username: SCREENSHOT_AGENT_USERNAME,
      email: SCREENSHOT_AGENT_EMAIL,
      passwordHash: 'hashed:pwd-2026',
      isTestAccount: true,
      isHidden: true,
      requiresUsernameSetup: false,
    });
    expect(call.update).toMatchObject({
      passwordHash: 'hashed:pwd-2026',
      isTestAccount: true,
      isHidden: true,
    });
  });

  it('идемпотентный повтор (юзер уже есть) → action=updated, без падения', async () => {
    const { prisma, upsert } = makePrisma({ exists: true });

    const result = await runSeedScreenshotAccount(prisma, 'pwd-2026');

    expect(result.action).toBe('updated');
    expect(result.user.id).toBe('uuid-existing');
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    // update перепрошивает passwordHash и форсит флаги — на случай
    // ручного сброса.
    expect(call.update).toMatchObject({
      passwordHash: 'hashed:pwd-2026',
      isTestAccount: true,
      isHidden: true,
    });
  });

  it('DB-ошибка из upsert пробрасывается наружу', async () => {
    const { prisma, upsert } = makePrisma({ exists: false });
    upsert.mockRejectedValueOnce(new Error('db down'));

    await expect(
      runSeedScreenshotAccount(prisma, 'pwd-2026'),
    ).rejects.toThrow(/db down/);
  });

  it('username и email — фиксированные константы (`__screenshot_agent`)', async () => {
    expect(SCREENSHOT_AGENT_USERNAME).toBe('__screenshot_agent');
    expect(SCREENSHOT_AGENT_EMAIL).toBe('__screenshot_agent@kingside.local');
  });
});
