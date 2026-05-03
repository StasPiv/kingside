jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt');

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let configService: any;
  let i18n: any;

  const mockUser = {
    id: '11111111-1111-4111-a111-111111111111',
    username: 'testuser',
    email: 'test@example.com',
    passwordHash: '$2b$10$hashedpassword',
    ratingBullet: 1200,
    ratingBlitz: 1200,
    ratingRapid: 1200,
    ratingClassical: 1200,
    createdAt: new Date(),
    locale: 'en',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-token'),
      verify: jest.fn(),
    };

    configService = {
      get: jest.fn().mockReturnValue('15m'),
    };

    i18n = {
      t: jest.fn((key: string) => key),
    };

    service = new AuthService(prisma, jwtService, configService, i18n);
  });

  describe('findOrCreateOAuthUser', () => {
    const cyrillicProfile = {
      provider: 'facebook',
      providerId: '123456789012345',
      email: null,
      displayName: 'Стас Пивоварцев',
    };

    const cyrillicProfileWithEmail = {
      provider: 'facebook',
      providerId: '123456789012345',
      email: 'stas@example.com',
      displayName: 'Стас Пивоварцев',
    };

    const latinProfileWithEmail = {
      provider: 'facebook',
      providerId: '123456789012345',
      email: 'piv1986@yandex.ru',
      displayName: 'Stas Pivovartsev',
      firstName: 'Stas',
      lastName: 'Pivovartsev',
    };

    const latinProfileNoEmail = {
      provider: 'facebook',
      providerId: '123456789012345',
      email: null,
      displayName: 'Stas Pivovartsev',
      firstName: 'Stas',
      lastName: 'Pivovartsev',
    };

    it('should return pending tokens for new Cyrillic user without email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.findOrCreateOAuthUser(cyrillicProfile);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.requiresUsernameSetup).toBe(true);
      expect(result.accessToken).toBe('mock-token');
    });

    it('should return pending tokens for new Cyrillic user with email (no existing user)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null); // no user by email

      const result = await service.findOrCreateOAuthUser(cyrillicProfileWithEmail);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.requiresUsernameSetup).toBe(true);
    });

    it('should link account when existing user found by email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, requiresUsernameSetup: false });

      const result = await service.findOrCreateOAuthUser(cyrillicProfileWithEmail);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockUser.id },
          data: expect.objectContaining({ oauthProvider: 'facebook' }),
        }),
      );
      expect(result.accessToken).toBe('mock-token');
    });

    it('should return existing user tokens without creating new user on repeated auth', async () => {
      const existingUser = {
        ...mockUser,
        username: 'user1234567890',
        oauthProvider: 'facebook',
        oauthProviderId: '123456789012345',
      };
      prisma.user.findFirst.mockResolvedValue(existingUser);
      prisma.user.update.mockResolvedValue(existingUser);

      const result = await service.findOrCreateOAuthUser(cyrillicProfile);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.accessToken).toBe('mock-token');
    });

    it('should update lastSeenAt for existing user by provider', async () => {
      const existingUser = {
        ...mockUser,
        oauthProvider: 'facebook',
        oauthProviderId: '123456789012345',
        requiresUsernameSetup: false,
      };
      prisma.user.findFirst.mockResolvedValue(existingUser);

      await service.findOrCreateOAuthUser(cyrillicProfile);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: { lastSeenAt: expect.any(Date) },
      });
    });

    it('should return pending tokens for new Latin user with email (no existing)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.findOrCreateOAuthUser(latinProfileWithEmail);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.requiresUsernameSetup).toBe(true);
    });

    it('should return pending tokens for new Latin user without email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.findOrCreateOAuthUser(latinProfileNoEmail);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.requiresUsernameSetup).toBe(true);
    });
  });

  describe('register', () => {
    it('should register a new user and return tokens', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('$2b$10$hashedpassword');

      const result = await service.register({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: 'testuser',
          email: 'test@example.com',
          passwordHash: '$2b$10$hashedpassword',
        },
      });
    });

    it('should throw ConflictException when username or email taken', async () => {
      prisma.user.findFirst.mockResolvedValue(mockUser);

      await expect(
        service.register({
          username: 'testuser',
          email: 'test@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should hash password with salt rounds 10', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');

      await service.register({
        username: 'newuser',
        email: 'new@example.com',
        password: 'mypassword',
      });

      expect(bcrypt.hash).toHaveBeenCalledWith('mypassword', 10);
    });

    it('KS-2255: register не выставляет isTestAccount/isHidden — полагаемся на DEFAULT FALSE из БД', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');

      await service.register({
        username: 'newuser',
        email: 'new@example.com',
        password: 'mypassword',
      });

      const callArg = (prisma.user.create as jest.Mock).mock.calls[0][0];
      // Контроль: новые поля не передаются — БД проставит DEFAULT FALSE
      // (миграция 20260503100000_add_user_test_account_hidden, ADR-036 §3).
      expect(callArg.data).not.toHaveProperty('isTestAccount');
      expect(callArg.data).not.toHaveProperty('isHidden');
    });

    it('should check for duplicate by username and email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(mockUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');

      await service.register({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [{ username: 'testuser' }, { email: 'test@example.com' }],
        },
      });
    });
  });

  describe('login', () => {
    it('should return tokens for valid credentials', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.user.update.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login({
        username: 'testuser',
        password: 'password123',
      });

      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ username: 'nobody', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for wrong password', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ username: 'testuser', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should update lastSeenAt on successful login', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.user.update.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login({ username: 'testuser', password: 'password123' });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: { lastSeenAt: expect.any(Date) },
      });
    });

    it('should verify password with bcrypt.compare', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.user.update.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login({ username: 'testuser', password: 'password123' });

      expect(bcrypt.compare).toHaveBeenCalledWith('password123', mockUser.passwordHash);
    });
  });

  describe('refresh', () => {
    it('should return new tokens for valid refresh token', async () => {
      jwtService.verify.mockReturnValue({ sub: mockUser.id, username: mockUser.username });

      const result = await service.refresh('valid-refresh-token');

      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
    });

    it('should verify token with JWT_SECRET', async () => {
      configService.get.mockReturnValue('my-secret');
      jwtService.verify.mockReturnValue({ sub: mockUser.id, username: mockUser.username });

      await service.refresh('some-token');

      expect(jwtService.verify).toHaveBeenCalledWith('some-token', {
        secret: 'my-secret',
      });
    });

    it('should throw UnauthorizedException for invalid refresh token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      await expect(service.refresh('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('devBypass — KS-2254 (security)', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('throws ForbiddenException on NODE_ENV=production даже с валидным секретом', async () => {
      process.env.NODE_ENV = 'production';
      // Сервис не должен дойти до сравнения секрета — выходим раньше.
      configService.get.mockImplementation((key: string) =>
        key === 'DEV_BYPASS_SECRET' ? 'right-secret' : '15m',
      );

      await expect(service.devBypass('right-secret')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Никаких походов в БД на проде.
      expect(prisma.user.upsert).toBeUndefined?.();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException on NODE_ENV=production без секрета (тоже отрезается)', async () => {
      process.env.NODE_ENV = 'production';
      await expect(service.devBypass('')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('пускает с валидным секретом на dev (NODE_ENV=development)', async () => {
      process.env.NODE_ENV = 'development';
      configService.get.mockImplementation((key: string) =>
        key === 'DEV_BYPASS_SECRET' ? 'right-secret' : '15m',
      );
      const upsertedUser = {
        id: '00000000-0000-4000-a000-000000000000',
        username: 'dev',
      };
      prisma.user.upsert = jest.fn().mockResolvedValue(upsertedUser);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');

      const result = await service.devBypass('right-secret');

      expect(prisma.user.upsert).toHaveBeenCalled();
      expect(result.accessToken).toBe('mock-token');
    });

    it('throws ForbiddenException на dev с неправильным секретом', async () => {
      process.env.NODE_ENV = 'development';
      configService.get.mockImplementation((key: string) =>
        key === 'DEV_BYPASS_SECRET' ? 'right-secret' : '15m',
      );

      await expect(service.devBypass('wrong-secret')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('getMe', () => {
    it('should return user profile without password', async () => {
      const profile = {
        id: mockUser.id,
        username: mockUser.username,
        email: mockUser.email,
        ratingBullet: 1200,
        ratingBlitz: 1200,
        ratingRapid: 1200,
        ratingClassical: 1200,
        createdAt: mockUser.createdAt,
        locale: 'en',
      };
      prisma.user.findUnique.mockResolvedValue(profile);

      const result = await service.getMe(mockUser.id);

      expect(result).toEqual(profile);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('should query with correct select fields', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.getMe(mockUser.id);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        select: {
          id: true,
          username: true,
          email: true,
          ratingBullet: true,
          ratingBlitz: true,
          ratingRapid: true,
          ratingClassical: true,
          createdAt: true,
          locale: true,
          boardTheme: true,
          pieceSet: true,
          soundEnabled: true,
        },
      });
    });

    it('should return null if user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.getMe('non-existent-id');

      expect(result).toBeNull();
    });
  });
});
