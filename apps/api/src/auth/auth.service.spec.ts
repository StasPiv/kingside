jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { ConflictException, UnauthorizedException } from '@nestjs/common';
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
        update: jest.fn(),
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
