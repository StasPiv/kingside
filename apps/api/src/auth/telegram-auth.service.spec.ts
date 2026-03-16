import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

function buildTelegramData(
  botToken: string,
  overrides: Partial<{
    id: number;
    first_name: string;
    auth_date: number;
    hash: string;
  }> = {},
) {
  const id = overrides.id ?? 123456789;
  const first_name = overrides.first_name ?? 'Test';
  const auth_date =
    overrides.auth_date ?? Math.floor(Date.now() / 1000) - 100;

  const data = { id, first_name, auth_date };

  const checkString = Object.keys(data)
    .sort()
    .map((key) => `${key}=${(data as Record<string, unknown>)[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hash =
    overrides.hash ??
    crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  return { ...data, hash };
}

describe('AuthService.telegramAuth', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let configService: any;
  let i18n: any;

  const BOT_TOKEN = 'test-bot-token:ABC123';

  const mockUser = {
    id: '11111111-1111-4111-a111-111111111111',
    username: null,
    requiresUsernameSetup: true,
    telegramId: '123456789',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-token'),
    };

    configService = {
      get: jest.fn((key: string, def?: string) => {
        if (key === 'TELEGRAM_BOT_TOKEN') return BOT_TOKEN;
        return def ?? '15m';
      }),
    };

    i18n = { t: jest.fn((key: string) => key) };

    service = new AuthService(prisma, jwtService, configService, i18n);
  });

  describe('Scenario: Успешная авторизация', () => {
    it('создаёт нового пользователя и возвращает JWT tokens', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockUser);

      const dto = buildTelegramData(BOT_TOKEN);
      const result = await service.telegramAuth(dto);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          telegramId: String(dto.id),
          requiresUsernameSetup: true,
        }),
      });
      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
    });
  });

  describe('Scenario: Невалидный hash', () => {
    it('возвращает 401 при некорректном hash', async () => {
      const dto = buildTelegramData(BOT_TOKEN, { hash: 'invalid-hash' });

      await expect(service.telegramAuth(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Scenario: Устаревший auth_date', () => {
    it('возвращает 401 когда auth_date старше 86400 секунд', async () => {
      const expiredAuthDate = Math.floor(Date.now() / 1000) - 90000;
      const dto = buildTelegramData(BOT_TOKEN, { auth_date: expiredAuthDate });

      await expect(service.telegramAuth(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Scenario: Пользователь уже существует', () => {
    it('не создаёт дубликат и возвращает новые JWT tokens', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.user.update.mockResolvedValue(mockUser);

      const dto = buildTelegramData(BOT_TOKEN);
      const result = await service.telegramAuth(dto);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
    });

    it('обновляет lastSeenAt при повторной авторизации', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.user.update.mockResolvedValue(mockUser);

      const dto = buildTelegramData(BOT_TOKEN);
      await service.telegramAuth(dto);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: { lastSeenAt: expect.any(Date) },
      });
    });
  });

  describe('TELEGRAM_BOT_TOKEN не настроен', () => {
    it('возвращает 401', async () => {
      configService.get = jest.fn().mockReturnValue(undefined);

      const dto = buildTelegramData(BOT_TOKEN);
      await expect(service.telegramAuth(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
