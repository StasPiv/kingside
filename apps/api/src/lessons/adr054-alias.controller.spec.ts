/**
 * KS-2642 / ADR-054 §4 Phase C — e2e-style тесты alias-контроллеров.
 * Поднимаем минимальное Nest-приложение с зарегистрированными alias-
 * контроллерами и через `supertest` проверяем, что:
 *   1. На каждый legacy-роут отдаётся `308 Permanent Redirect`.
 *   2. `Location`-заголовок содержит правильный унифицированный URL.
 *   3. Response body содержит метку `tag: 'adr054-phase-c-alias'` для
 *      полевой диагностики.
 *   4. HTTP-метод сохраняется (308 ≠ 301: POST→POST), поэтому проверяем
 *      разные verbs.
 *   5. Query-string пробрасывается без потерь.
 */

import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  Adr054UserCoursesAliasController,
  Adr054UserLessonsAliasController,
  Adr054UserLessonStepsAliasController,
  Adr054UserProgressAliasController,
} from './adr054-alias.controller';

describe('Adr054*AliasController — KS-2642', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        Adr054UserCoursesAliasController,
        Adr054UserLessonsAliasController,
        Adr054UserLessonStepsAliasController,
        Adr054UserProgressAliasController,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('user-courses', () => {
    it('GET /lessons/user-courses → 308 → /lessons/courses', async () => {
      const res = await request(app.getHttpServer()).get('/lessons/user-courses');
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses');
      expect(res.body).toMatchObject({
        deprecation: true,
        location: '/lessons/courses',
        tag: 'adr054-phase-c-alias',
      });
    });

    it('GET /lessons/user-courses/enrolled → 308 → /lessons/courses/enrolled', async () => {
      const res = await request(app.getHttpServer()).get(
        '/lessons/user-courses/enrolled',
      );
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses/enrolled');
    });

    it('GET /lessons/user-courses/:slug → 308 → /lessons/courses/:slug', async () => {
      const res = await request(app.getHttpServer()).get(
        '/lessons/user-courses/my-slug',
      );
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses/my-slug');
    });

    it('POST /lessons/user-courses → 308 (метод сохраняется per RFC 7538)', async () => {
      const res = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .send({ title: 'X' });
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses');
    });

    it('PATCH /lessons/user-courses/:id → 308', async () => {
      const res = await request(app.getHttpServer())
        .patch('/lessons/user-courses/abc')
        .send({ isPublic: true });
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses/abc');
    });

    it('DELETE /lessons/user-courses/:id → 308', async () => {
      const res = await request(app.getHttpServer()).delete(
        '/lessons/user-courses/abc',
      );
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses/abc');
    });

    it('POST /lessons/user-courses/:id/lessons → 308', async () => {
      const res = await request(app.getHttpServer())
        .post('/lessons/user-courses/abc/lessons')
        .send({ title: 'L1' });
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses/abc/lessons');
    });

    it('GET /lessons/user-courses?mine=1 → 308 (query пробрасывается)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/lessons/user-courses?mine=1&limit=10',
      );
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/courses?mine=1&limit=10');
    });
  });

  describe('user-lessons', () => {
    it('GET /lessons/user-lessons/:id → 308 → /lessons/lessons/:id', async () => {
      const res = await request(app.getHttpServer()).get(
        '/lessons/user-lessons/L1',
      );
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/lessons/L1');
    });

    it('PATCH /lessons/user-lessons/:id → 308', async () => {
      const res = await request(app.getHttpServer())
        .patch('/lessons/user-lessons/L1')
        .send({ order: 1 });
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/lessons/L1');
    });

    it('POST /lessons/user-lessons/:id/steps → 308 → /lessons/lessons/:id/steps', async () => {
      const res = await request(app.getHttpServer())
        .post('/lessons/user-lessons/L1/steps')
        .send({ type: 'text', payload: {} });
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/lessons/L1/steps');
    });
  });

  describe('user-lesson-steps', () => {
    it('PATCH /lessons/user-lesson-steps/:id → 308 → /lessons/steps/:id', async () => {
      const res = await request(app.getHttpServer())
        .patch('/lessons/user-lesson-steps/S1')
        .send({ order: 0 });
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/steps/S1');
    });

    it('DELETE /lessons/user-lesson-steps/:id → 308', async () => {
      const res = await request(app.getHttpServer()).delete(
        '/lessons/user-lesson-steps/S1',
      );
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe('/lessons/steps/S1');
    });
  });

  describe('user-progress', () => {
    it.each([
      ['GET', '/lessons/user-progress/courses/C1', '/lessons/progress/courses/C1'],
      ['GET', '/lessons/user-progress/lessons/L1', '/lessons/progress/lessons/L1'],
      ['POST', '/lessons/user-progress/lessons/L1/step', '/lessons/progress/lessons/L1/step'],
      [
        'POST',
        '/lessons/user-progress/lessons/L1/complete',
        '/lessons/progress/lessons/L1/complete',
      ],
    ])('%s %s → 308 → %s', async (method, from, to) => {
      const httpMethod = method.toLowerCase() as 'get' | 'post';
      const res = await request(app.getHttpServer())[httpMethod](from);
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe(to);
    });
  });
});
