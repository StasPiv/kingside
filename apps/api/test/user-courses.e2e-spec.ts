import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { USER_COURSES_LIMITS } from '../src/lessons/user-courses/user-courses-limits';
import { USER_COURSES_RATE_LIMITS } from '../src/lessons/user-courses/rate-limits';

/**
 * E2E-тесты для UserCoursesModule (ADR-026 §6, KS-1834).
 *
 * Требования окружения:
 *  - PostgreSQL запущен на DATABASE_URL (apps/api/.env).
 *  - Redis запущен на REDIS_HOST/PORT — нужен для `UserRateLimitGuard`.
 *    Если Redis недоступен, guard работает в fail-open режиме и тест
 *    на rate-limit станет ложно-зелёным; поэтому в начале отдельно
 *    проверяем Redis ping (skip с warning, если нет).
 *
 * Тесты бьют по реальным эндпоинтам поднятого AppModule через
 * supertest. Каждый регистрирует уникального юзера (username с
 * nanoid-суффиксом) и удаляет его после — cascade удаляет курсы и
 * прогресс, оставляя базу чистой.
 */

jest.setTimeout(30_000);

describe('UserCoursesModule e2e (KS-1834)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let redisAvailable = false;

  // Регистрация тестового юзера: возвращает accessToken + id.
  async function registerUser(prefix: string): Promise<{ id: string; token: string }> {
    const suffix = randomUUID().slice(0, 8);
    const username = `${prefix}_${suffix}`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username,
        email: `${username}@e2e.local`,
        password: 'Test1234!',
      })
      .expect(201);

    const token = res.body.accessToken as string;
    // Достаём userId из JWT без валидации подписи — он нужен только для
    // cleanup'а и формирования ключей rate-limit.
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    return { id: payload.sub as string, token };
  }

  const createdUserIds: string[] = [];
  async function spawnUser(prefix: string) {
    const u = await registerUser(prefix);
    createdUserIds.push(u.id);
    return u;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Повторяем настройки из main.ts — чтобы ValidationPipe + фильтр
    // ошибок работали так же, как в проде.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    // Проверяем Redis — если нет, тест rate-limit уйдёт в skip.
    try {
      const pong = await redis.ping();
      redisAvailable = pong === 'PONG';
    } catch {
      redisAvailable = false;
    }
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Happy path
  // ──────────────────────────────────────────────────────────────

  describe('Happy path', () => {
    it('создать курс → добавить урок → шаги (text + puzzle) → прогресс → complete', async () => {
      const owner = await spawnUser('uc_happy');

      // 1. Создаём курс
      const courseRes = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'E2E course', description: 'integration' })
        .expect(201);
      const courseId = courseRes.body.id as string;
      const courseSlug = courseRes.body.slug as string;
      expect(courseRes.body.ownerId).toBe(owner.id);
      expect(courseSlug).toMatch(/^[a-z0-9]+-e2e-course$/);

      // 2. Добавляем урок
      const lessonRes = await request(app.getHttpServer())
        .post(`/lessons/user-courses/${courseId}/lessons`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Lesson 1', estMinutes: 5 })
        .expect(201);
      const lessonId = lessonRes.body.id as string;
      expect(lessonRes.body.order).toBe(0);

      // 3. Два шага: text + puzzle (фикстура из DoD)
      const textRes = await request(app.getHttpServer())
        .post(`/lessons/user-lessons/${lessonId}/steps`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'text',
          payload: { type: 'text', bodyMarkdown: 'Hello e2e' },
        })
        .expect(201);
      const textStepId = textRes.body.id as string;
      expect(textRes.body.order).toBe(0);

      const puzzleRes = await request(app.getHttpServer())
        .post(`/lessons/user-lessons/${lessonId}/steps`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'puzzle',
          payload: {
            type: 'puzzle',
            selection: {
              mode: 'filter',
              themes: ['fork'],
              limit: 10,
            },
          },
        })
        .expect(201);
      expect(puzzleRes.body.order).toBe(1);

      // 4. Проверяем сводный GET /user-lessons/:id
      const lessonWithSteps = await request(app.getHttpServer())
        .get(`/lessons/user-lessons/${lessonId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(lessonWithSteps.body.steps).toHaveLength(2);
      expect(lessonWithSteps.body.progress).toBeNull();

      // 5. Отмечаем прогресс по первому шагу (text)
      const stepProgress = await request(app.getHttpServer())
        .post(`/lessons/user-progress/lessons/${lessonId}/step`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ stepId: textStepId, state: 'done' })
        .expect(201);
      expect(stepProgress.body).toMatchObject({
        completedStepsCount: 1,
        totalSteps: 2,
        completedAt: null,
      });

      // 6. Complete lesson
      const completeRes = await request(app.getHttpServer())
        .post(`/lessons/user-progress/lessons/${lessonId}/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ score: 1 })
        .expect(201);
      expect(completeRes.body.completedAt).not.toBeNull();

      // 7. Прогресс курса — completedLessonsCount=1
      const courseProgress = await request(app.getHttpServer())
        .get(`/lessons/user-progress/courses/${courseId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(courseProgress.body).toMatchObject({
        userCourseId: courseId,
        completedLessonsCount: 1,
      });

      // 8. Повторный complete — счётчик курса остаётся 1 (идемпотентность)
      await request(app.getHttpServer())
        .post(`/lessons/user-progress/lessons/${lessonId}/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ score: 1 })
        .expect(201);
      const courseProgress2 = await request(app.getHttpServer())
        .get(`/lessons/user-progress/courses/${courseId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(courseProgress2.body.completedLessonsCount).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Negative: чужой owner → 404 (не 403)
  // ──────────────────────────────────────────────────────────────

  describe('Negative: чужой owner', () => {
    it('PATCH /user-courses/:id чужого → 404', async () => {
      const owner = await spawnUser('uc_own');
      const outsider = await spawnUser('uc_out');

      // Owner создаёт приватный курс
      const courseRes = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Owner private course' })
        .expect(201);
      const courseId = courseRes.body.id as string;

      await request(app.getHttpServer())
        .patch(`/lessons/user-courses/${courseId}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ title: 'Hacked' })
        .expect(404);
    });

    it('DELETE /user-courses/:id чужого → 404', async () => {
      const owner = await spawnUser('uc_own');
      const outsider = await spawnUser('uc_out');

      const courseRes = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Will not delete' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/lessons/user-courses/${courseRes.body.id}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);

      // И убеждаемся, что курс всё ещё на месте у owner'а.
      await request(app.getHttpServer())
        .get(`/lessons/user-courses/${courseRes.body.slug}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Negative: whitelist типов шага
  // ──────────────────────────────────────────────────────────────

  describe('Negative: whitelist step type', () => {
    async function setupOwnerLesson() {
      const owner = await spawnUser('uc_wl');
      const courseRes = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Whitelist test' })
        .expect(201);
      const lessonRes = await request(app.getHttpServer())
        .post(`/lessons/user-courses/${courseRes.body.id}/lessons`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'L' })
        .expect(201);
      return { token: owner.token, lessonId: lessonRes.body.id as string };
    }

    it.each(['video', 'quiz', 'game_review', 'opening_drill', 'position'])(
      'type=%s → 400 с сообщением "not allowed"',
      async (type) => {
        const { token, lessonId } = await setupOwnerLesson();
        const res = await request(app.getHttpServer())
          .post(`/lessons/user-lessons/${lessonId}/steps`)
          .set('Authorization', `Bearer ${token}`)
          .send({ type, payload: { type } })
          .expect(400);
        const message = JSON.stringify(res.body.message);
        expect(message).toContain('not allowed');
      },
    );
  });

  // ──────────────────────────────────────────────────────────────
  // Negative: лимит 20 курсов на пользователя
  // ──────────────────────────────────────────────────────────────

  describe('Negative: лимит 20 курсов', () => {
    it('21-й курс → 400 Courses per user limit reached', async () => {
      const owner = await spawnUser('uc_lim');

      // Предзаполняем 20 курсов напрямую через prisma — быстрее, чем
      // ходить через API с rate-limit'ом.
      const inserts = Array.from({ length: USER_COURSES_LIMITS.coursesPerUser }).map(
        (_, i) =>
          prisma.userCourse.create({
            data: {
              ownerId: owner.id,
              slug: `e2e-lim-${owner.id.slice(0, 6)}-${i}`,
              title: `Seed course ${i}`,
            },
          }),
      );
      await Promise.all(inserts);

      const res = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Twenty first' })
        .expect(400);
      expect(String(res.body.message)).toContain('Courses per user limit');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Negative: rate-limit POST /user-courses (5/10min)
  // ──────────────────────────────────────────────────────────────

  describe('Negative: rate-limit', () => {
    it('6-й POST /user-courses подряд → 429 с Retry-After', async () => {
      if (!redisAvailable) {
        // fail-open guard сделает тест бесполезным — skip.
        console.warn('Redis недоступен, пропускаю rate-limit тест');
        return;
      }

      const owner = await spawnUser('uc_rl');

      // Сбрасываем возможный хвост лимитов из предыдущих прогонов —
      // сам userId уникален, но на всякий.
      const keys = await redis.keys(`ratelimit:user:${owner.id}:*`);
      if (keys.length > 0) await redis.del(...keys);

      const limit = USER_COURSES_RATE_LIMITS.createCourse.maxRequests; // 5
      for (let i = 0; i < limit; i++) {
        await request(app.getHttpServer())
          .post('/lessons/user-courses')
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ title: `Rate ${i}` })
          .expect(201);
      }

      // 6-й должен отбиться.
      const res = await request(app.getHttpServer())
        .post('/lessons/user-courses')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Over limit' })
        .expect(429);

      // Заголовок `Retry-After` guard выставляет до throw'а — и он не
      // теряется в `AllExceptionsFilter` (тот переписывает только тело
      // в формат `{statusCode, message, path}`). Значение — секунды до
      // сброса окна (> 0, может колебаться от windowSec до windowSec-1
      // в зависимости от времени между incr и ttl).
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
  });
});
