jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let configService: any;
  let i18n: any;

  const userId = '11111111-1111-4111-a111-111111111111';

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    } as any;

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-token'),
      verify: jest.fn(),
    } as any;

    configService = {
      get: jest.fn((key: string, defaultValue?: string) => defaultValue ?? 'mock-value'),
    } as any;

    i18n = {
      t: jest.fn((key: string) => key),
    } as any;

    service = new AuthService(prisma, jwtService, configService, i18n);
  });

  describe('register', () => {
    const dto = { username: 'testuser', email: 'test@example.com', password: 'password123' };

    it('should throw ConflictException if username or email already exists', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'existing-id' });

      await expect(service.register(dto)).rejects.toThrow(ConflictException);
    });

    it('should hash the password', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: userId, username: dto.username });

      await service.register(dto);

      expect(bcrypt.hash).toHaveBeenCalledWith(dto.password, 10);
    });

    it('should create user with hashed password', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: userId, username: dto.username });

      await service.register(dto);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: dto.username,
          email: dto.email,
          passwordHash: expect.any(String),
        },
      });

      const savedHash = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(savedHash).not.toBe(dto.password);
    });

    it('should return tokens after successful registration', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: userId, username: dto.username });

      const result = await service.register(dto);

      expect(result).toEqual({ accessToken: 'mock-token', refreshToken: 'mock-token' });
      expect(jwtService.sign).toHaveBeenCalledTimes(2);
    });

    it('should check for duplicate by username and email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: userId, username: dto.username });

      await service.register(dto);

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [{ username: dto.username }, { email: dto.email }],
        },
      });
    });
  });

  describe('login', () => {
    const dto = { username: 'testuser', password: 'password123' };
    const mockUser = {
      id: userId,
      username: 'testuser',
      passwordHash: '$2b$10$hashedpassword',
    };

    it('should throw UnauthorizedException if user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if password is invalid', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('should update lastSeenAt on successful login', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login(dto);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: { lastSeenAt: expect.any(Date) },
      });
    });

    it('should return tokens on successful login', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login(dto);

      expect(result).toEqual({ accessToken: 'mock-token', refreshToken: 'mock-token' });
    });

    it('should verify password with bcrypt.compare', async () => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login(dto);

      expect(bcrypt.compare).toHaveBeenCalledWith(dto.password, mockUser.passwordHash);
    });
  });

  describe('refresh', () => {
    it('should return new tokens for valid refresh token', async () => {
      jwtService.verify.mockReturnValue({ sub: userId, username: 'testuser' });

      const result = await service.refresh('valid-refresh-token');

      expect(result).toEqual({ accessToken: 'mock-token', refreshToken: 'mock-token' });
    });

    it('should verify token with JWT_SECRET', async () => {
      configService.get.mockReturnValue('my-secret');
      jwtService.verify.mockReturnValue({ sub: userId, username: 'testuser' });

      await service.refresh('some-token');

      expect(jwtService.verify).toHaveBeenCalledWith('some-token', {
        secret: 'my-secret',
      });
    });

    it('should throw UnauthorizedException for invalid refresh token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });

      await expect(service.refresh('invalid-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('getMe', () => {
    it('should return user data with selected fields', async () => {
      const mockUser = {
        id: userId,
        username: 'testuser',
        email: 'test@example.com',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
        createdAt: new Date(),
        locale: 'en',
      };
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.getMe(userId);

      expect(result).toEqual(mockUser);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
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
