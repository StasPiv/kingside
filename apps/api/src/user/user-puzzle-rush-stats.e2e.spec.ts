/**
 * E2E tests for GET /users/:id/puzzle-rush-stats
 *
 * Verifies:
 *   1. Correct response structure (best3, best5, totalSessions)
 *   2. Default/zero values for user without sessions
 *   3. 404 for non-existent user
 *   4. Endpoint is public (no auth required)
 *   5. Data correctness after puzzle rush sessions
 *   6. Invalid UUID rejection
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
  ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('GET /users/:id/puzzle-rush-stats E2E', () => {
  let app: INestApplication;

  const existingUserId = '11111111-1111-4111-a111-111111111111';
  const noSessionsUserId = '22222222-2222-4222-a222-222222222222';
  const nonExistentUserId = '99999999-9999-4999-a999-999999999999';

  const mockService = {
    getProfile: jest.fn(),
    getPuzzleRushStats: jest.fn(),
    updateSettings: jest.fn(),
    changePassword: jest.fn(),
    getUserGames: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: mockService },
        { provide: AuthService, useValue: { generateTokens: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: existingUserId };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('response structure', () => {
    it('should return { best3, best5, totalSessions } with correct types', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 15,
        best5: 22,
        totalSessions: 10,
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        best3: 15,
        best5: 22,
        totalSessions: 10,
      });
      expect(typeof res.body.best3).toBe('number');
      expect(typeof res.body.best5).toBe('number');
      expect(typeof res.body.totalSessions).toBe('number');
    });

    it('should call service with correct userId', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 0,
        best5: 0,
        totalSessions: 0,
      });

      await request(app.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      expect(mockService.getPuzzleRushStats).toHaveBeenCalledWith(
        existingUserId,
      );
    });
  });

  describe('user without sessions', () => {
    it('should return zero/default values', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 0,
        best5: 0,
        totalSessions: 0,
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${noSessionsUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        best3: 0,
        best5: 0,
        totalSessions: 0,
      });
    });
  });

  describe('non-existent user', () => {
    it('should return 404', async () => {
      mockService.getPuzzleRushStats.mockRejectedValue(
        new NotFoundException('User not found'),
      );

      const res = await request(app.getHttpServer())
        .get(`/users/${nonExistentUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('User not found');
    });
  });

  describe('invalid UUID', () => {
    it('should return 400 for invalid UUID format', async () => {
      const res = await request(app.getHttpServer())
        .get('/users/not-a-uuid/puzzle-rush-stats');

      expect(res.status).toBe(400);
      expect(mockService.getPuzzleRushStats).not.toHaveBeenCalled();
    });
  });

  describe('data correctness after sessions', () => {
    it('should reflect best3 higher than best5', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 30,
        best5: 10,
        totalSessions: 5,
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(200);
      expect(res.body.best3).toBe(30);
      expect(res.body.best5).toBe(10);
      expect(res.body.totalSessions).toBe(5);
    });

    it('should reflect best5 higher than best3', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 8,
        best5: 25,
        totalSessions: 3,
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(200);
      expect(res.body.best3).toBe(8);
      expect(res.body.best5).toBe(25);
    });

    it('should reflect only 3-min sessions played', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 12,
        best5: 0,
        totalSessions: 4,
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(200);
      expect(res.body.best3).toBe(12);
      expect(res.body.best5).toBe(0);
      expect(res.body.totalSessions).toBe(4);
    });

    it('should reflect only 5-min sessions played', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 0,
        best5: 18,
        totalSessions: 2,
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      expect(res.status).toBe(200);
      expect(res.body.best3).toBe(0);
      expect(res.body.best5).toBe(18);
      expect(res.body.totalSessions).toBe(2);
    });
  });

  describe('public access (no auth required)', () => {
    let publicApp: INestApplication;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [UserController],
        providers: [
          { provide: UserService, useValue: mockService },
          { provide: AuthService, useValue: { generateTokens: jest.fn() } },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: () => false,
        })
        .compile();

      publicApp = module.createNestApplication();
      publicApp.useGlobalPipes(new ValidationPipe({ whitelist: true }));
      await publicApp.init();
    });

    afterAll(async () => {
      await publicApp.close();
    });

    it('should be accessible without authentication', async () => {
      mockService.getPuzzleRushStats.mockResolvedValue({
        best3: 0,
        best5: 0,
        totalSessions: 0,
      });

      const res = await request(publicApp.getHttpServer())
        .get(`/users/${existingUserId}/puzzle-rush-stats`);

      // Endpoint has no @UseGuards(JwtAuthGuard), so it should return 200
      // even when guard rejects (guard only applies to decorated routes)
      expect(res.status).toBe(200);
      expect(mockService.getPuzzleRushStats).toHaveBeenCalledWith(
        existingUserId,
      );
    });

    it('should block access to protected endpoints', async () => {
      // Verify that auth guard works for protected endpoints (settings)
      const res = await request(publicApp.getHttpServer())
        .patch('/users/me/settings')
        .send({ locale: 'en' });

      expect(res.status).toBe(403);
    });
  });
});
