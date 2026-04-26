import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';

/**
 * KS-1971 — E2E-тесты admin API (`/lessons/admin/...`).
 *
 * Что покрываем (см. acceptance KS-1971):
 *  1. Полный CRUD курса.
 *  2. CRUD урока в курсе.
 *  3. CRUD шага: text / position / puzzle / quiz.
 *  4. Reorder курсов / уроков / шагов — атомарность.
 *  5. Авторизация: без JWT → 401; не-админ JWT → 403; админ → 2xx.
 *  6. Каскадное удаление: Course → Lesson → Step.
 *  7. Регресс публичного API: после CRUD `/lessons/courses` и
 *     `/lessons/courses/:slug` отдают inline-поля + i18n.
 *
 * Окружение: PostgreSQL по DATABASE_URL (apps/api/.env).
 *
 * AdminEmailGuard читает `process.env.LESSON_ADMIN_EMAILS` при каждом
 * canActivate — поэтому ENV выставляем динамически в `beforeAll`,
 * а в `afterAll` восстанавливаем.
 */

jest.setTimeout(30_000);

describe('Admin API e2e (KS-1971)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let redisAvailable = false;

  const ENV_KEY = 'LESSON_ADMIN_EMAILS';
  const originalEnv = process.env[ENV_KEY];

  // Юзер-админ: его email мы кладём в whitelist.
  let admin: { id: string; email: string; token: string };
  // Юзер не-админ: его email НЕ в whitelist — 403.
  let stranger: { id: string; email: string; token: string };

  // Cleanup: id курсов, созданных админом — на случай, если тест
  // упал до DELETE и мусор остался.
  const adminCreatedCourseIds: string[] = [];
  const userIdsToCleanup: string[] = [];

  async function registerUser(prefix: string) {
    const suffix = randomUUID().slice(0, 8);
    const username = `${prefix}_${suffix}`;
    const email = `${username}@e2e.local`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username,
        email,
        password: 'Test1234!',
      })
      .expect(201);
    const token = res.body.accessToken as string;
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    return { id: payload.sub as string, email, token };
  }

  function adminAuth(req: request.Test) {
    return req.set('Authorization', `Bearer ${admin.token}`);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    try {
      const pong = await redis.ping();
      redisAvailable = pong === 'PONG';
    } catch {
      redisAvailable = false;
    }

    admin = await registerUser('adm');
    stranger = await registerUser('str');
    userIdsToCleanup.push(admin.id, stranger.id);

    // Включаем admin email в whitelist. Stranger остаётся снаружи.
    process.env[ENV_KEY] = admin.email;
  });

  afterAll(async () => {
    // Восстанавливаем ENV.
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;

    // Чистим оставшиеся курсы (cascade снесёт уроки/шаги/прогресс).
    if (adminCreatedCourseIds.length > 0) {
      await prisma.course.deleteMany({
        where: { id: { in: adminCreatedCourseIds } },
      });
    }
    if (userIdsToCleanup.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIdsToCleanup } } });
    }
    await app.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Сценарий 5: авторизация
  // ──────────────────────────────────────────────────────────────

  describe('Сценарий 5: авторизация', () => {
    it('GET без JWT → 401', async () => {
      await request(app.getHttpServer())
        .get('/lessons/admin/courses')
        .expect(401);
    });

    it('GET с JWT, email не в whitelist → 403', async () => {
      await request(app.getHttpServer())
        .get('/lessons/admin/courses')
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(403);
    });

    it('GET с JWT и email в whitelist → 200', async () => {
      const res = await adminAuth(
        request(app.getHttpServer()).get('/lessons/admin/courses'),
      ).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Сценарии 1, 2, 3, 4, 6, 7 — full flow
  // ──────────────────────────────────────────────────────────────

  describe('Сценарии 1/2/3/4/6/7: полный flow + регресс публичного API', () => {
    it('CRUD курса → урока → шагов (4 типа) → reorder → cascade delete → public API регресс', async () => {
      const slug = `e2e-${randomUUID().slice(0, 8)}`;

      // ── 1. CREATE COURSE ──────────────────────────────────────
      const create = await adminAuth(
        request(app.getHttpServer())
          .post('/lessons/admin/courses')
          .send({
            slug,
            level: 'beginner',
            titleKey: 'e2e.course.title',
            descriptionKey: 'e2e.course.desc',
            // inline (KS-1964) + i18n keys рядом — публичный API должен
            // отдать оба.
            title: 'E2E Course Inline',
            description: 'Inline description',
            audience: 'Audience',
            hook: 'Hook',
            outcome: 'Outcome',
            audienceI18nKey: 'e2e.course.audience',
            hookI18nKey: 'e2e.course.hook',
            outcomeI18nKey: 'e2e.course.outcome',
            difficulty: 2,
            isPublished: true,
          }),
      ).expect(201);
      const courseId = create.body.id as string;
      adminCreatedCourseIds.push(courseId);
      expect(create.body.slug).toBe(slug);
      expect(create.body.title).toBe('E2E Course Inline');

      // ── PATCH course ──────────────────────────────────────────
      const patched = await adminAuth(
        request(app.getHttpServer())
          .patch(`/lessons/admin/courses/${courseId}`)
          .send({ description: 'Updated', tags: ['endgame'] }),
      ).expect(200);
      expect(patched.body.description).toBe('Updated');
      expect(patched.body.tags).toEqual(['endgame']);

      // ── 2. CREATE LESSONS (3 шт. — для reorder) ───────────────
      const lessonIds: string[] = [];
      for (const i of [0, 1, 2]) {
        const res = await adminAuth(
          request(app.getHttpServer())
            .post(`/lessons/admin/courses/${courseId}/lessons`)
            .send({
              slug: `lesson-${i}`,
              blockKey: 'intro',
              kind: 'theory',
              titleKey: `e2e.lesson.${i}.title`,
              summaryKey: `e2e.lesson.${i}.summary`,
              title: `Lesson ${i} inline`,
              summary: `Summary ${i}`,
              isPublished: true,
            }),
        ).expect(201);
        lessonIds.push(res.body.id);
        expect(res.body.order).toBe(i);
      }

      // ── PATCH lesson ──────────────────────────────────────────
      await adminAuth(
        request(app.getHttpServer())
          .patch(`/lessons/admin/lessons/${lessonIds[0]}`)
          .send({ summary: 'Updated summary' }),
      ).expect(200);

      // ── GET lesson by id (drafts visible) ─────────────────────
      const fetched = await adminAuth(
        request(app.getHttpServer()).get(`/lessons/admin/lessons/${lessonIds[0]}`),
      ).expect(200);
      expect(fetched.body.summary).toBe('Updated summary');

      // ── 3. CREATE STEPS: text / position / puzzle / quiz ─────
      const lessonForSteps = lessonIds[0];

      const textStep = await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/lessons/${lessonForSteps}/steps`)
          .send({
            type: 'text',
            payload: {
              type: 'text',
              bodyMarkdown: '# Hello',
            },
          }),
      ).expect(201);

      const positionStep = await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/lessons/${lessonForSteps}/steps`)
          .send({
            type: 'position',
            payload: {
              type: 'position',
              fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              expectedMoves: ['e2e4'],
            },
          }),
      ).expect(201);

      const puzzleStep = await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/lessons/${lessonForSteps}/steps`)
          .send({
            type: 'puzzle',
            payload: {
              type: 'puzzle',
              selection: { mode: 'filter', themes: ['fork'], limit: 5 },
            },
          }),
      ).expect(201);

      const quizStep = await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/lessons/${lessonForSteps}/steps`)
          .send({
            type: 'quiz',
            payload: {
              type: 'quiz',
              questions: [
                {
                  id: 'q1',
                  promptI18nKey: 'q1',
                  options: [
                    { id: 'a', labelI18nKey: 'opt.a' },
                    { id: 'b', labelI18nKey: 'opt.b' },
                  ],
                  correctOptionIds: ['a'],
                },
              ],
              passThreshold: 1,
            },
          }),
      ).expect(201);

      const stepIds = [
        textStep.body.id,
        positionStep.body.id,
        puzzleStep.body.id,
        quizStep.body.id,
      ];
      expect(textStep.body.order).toBe(0);
      expect(quizStep.body.order).toBe(3);

      // ── PATCH step (text → quiz: смена type требует payload) ──
      await adminAuth(
        request(app.getHttpServer())
          .patch(`/lessons/admin/steps/${textStep.body.id}`)
          .send({ type: 'quiz' }),
      ).expect(400); // type меняется без payload

      // С правильным payload — ОК
      await adminAuth(
        request(app.getHttpServer())
          .patch(`/lessons/admin/steps/${textStep.body.id}`)
          .send({
            type: 'quiz',
            payload: {
              type: 'quiz',
              questions: [
                {
                  id: 'q1',
                  promptI18nKey: 'q1',
                  options: [
                    { id: 'a', labelI18nKey: 'a' },
                    { id: 'b', labelI18nKey: 'b' },
                  ],
                  correctOptionIds: ['a'],
                },
              ],
            },
          }),
      ).expect(200);

      // ── 4. REORDER ────────────────────────────────────────────

      // Reorder steps: переворот
      await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/lessons/${lessonForSteps}/steps/reorder`)
          .send({ ids: [...stepIds].reverse() }),
      ).expect(204);

      // Подтверждаем — порядок изменился
      const lessonAfterReorder = await adminAuth(
        request(app.getHttpServer()).get(`/lessons/admin/lessons/${lessonForSteps}`),
      ).expect(200);
      const orderedIds = lessonAfterReorder.body.steps.map((s: any) => s.id);
      expect(orderedIds).toEqual([...stepIds].reverse());

      // Reorder lessons: переворот
      await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/courses/${courseId}/lessons/reorder`)
          .send({ ids: [...lessonIds].reverse() }),
      ).expect(204);

      // Reorder lessons: некорректный набор → 400
      await adminAuth(
        request(app.getHttpServer())
          .post(`/lessons/admin/courses/${courseId}/lessons/reorder`)
          .send({ ids: [lessonIds[0]] }),
      ).expect(400);

      // Reorder courses: должен включать ВСЕ курсы; собираем актуальный список.
      const allCourses = await adminAuth(
        request(app.getHttpServer()).get('/lessons/admin/courses'),
      ).expect(200);
      const allCourseIds = allCourses.body.map((c: any) => c.id);
      await adminAuth(
        request(app.getHttpServer())
          .post('/lessons/admin/courses/reorder')
          .send({ ids: [...allCourseIds].reverse() }),
      ).expect(204);

      // ── 7. РЕГРЕСС ПУБЛИЧНОГО API ─────────────────────────────
      // GET /lessons/courses — публичный list (требует JWT, любой email).
      const publicList = await request(app.getHttpServer())
        .get('/lessons/courses')
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(200);
      const found = publicList.body.data.find((c: any) => c.id === courseId);
      expect(found).toBeDefined();
      // inline + i18n рядом (KS-1965/1966).
      expect(found.title).toBe('E2E Course Inline');
      expect(found.titleI18nKey).toBe('e2e.course.title');
      expect(found.description).toBe('Updated');
      expect(found.descriptionI18nKey).toBe('e2e.course.desc');
      expect(found.audience).toBe('Audience');
      expect(found.audienceI18nKey).toBe('e2e.course.audience');

      // GET /lessons/courses/:slug — детальный.
      const publicDetail = await request(app.getHttpServer())
        .get(`/lessons/courses/${slug}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(200);
      expect(publicDetail.body.course.title).toBe('E2E Course Inline');
      expect(publicDetail.body.course.descriptionI18nKey).toBe('e2e.course.desc');
      // Урок с inline полями.
      expect(publicDetail.body.lessons[0].title).toMatch(/Lesson \d inline/);
      expect(publicDetail.body.lessons[0].titleI18nKey).toMatch(/^e2e\.lesson\.\d\.title$/);

      // ── 6. КАСКАДНОЕ УДАЛЕНИЕ ─────────────────────────────────
      // DELETE step
      await adminAuth(
        request(app.getHttpServer()).delete(
          `/lessons/admin/steps/${stepIds[0]}`,
        ),
      ).expect(204);

      // DELETE lesson — каскад снесёт оставшиеся шаги
      await adminAuth(
        request(app.getHttpServer()).delete(
          `/lessons/admin/lessons/${lessonForSteps}`,
        ),
      ).expect(204);
      // Шагов в БД нет
      const remainingSteps = await prisma.lessonStep.count({
        where: { id: { in: stepIds } },
      });
      expect(remainingSteps).toBe(0);

      // DELETE course — каскад снесёт оставшиеся уроки
      await adminAuth(
        request(app.getHttpServer()).delete(`/lessons/admin/courses/${courseId}`),
      ).expect(204);
      const remainingLessons = await prisma.lesson.count({
        where: { id: { in: lessonIds } },
      });
      expect(remainingLessons).toBe(0);

      // Удаляем из cleanup-списка — уже снесли вручную
      const idx = adminCreatedCourseIds.indexOf(courseId);
      if (idx >= 0) adminCreatedCourseIds.splice(idx, 1);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Сценарий 5b: 401/403 на write-роутах (не только GET)
  // ──────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────
  // KS-1972: rate limit на admin-эндпоинтах (100 req/min на user)
  // ──────────────────────────────────────────────────────────────

  describe('KS-1972: rate limit', () => {
    it('после 100 запросов следующий → 429 + Retry-After', async () => {
      if (!redisAvailable) {
        // Redis недоступен → guard в fail-open, тест станет ложно-зелёным.
        // Помечаем как skip-with-warn.
        // eslint-disable-next-line no-console
        console.warn('[KS-1972 e2e] Redis недоступен — пропускаю rate-limit');
        return;
      }

      // Устанавливаем счётчик в БД равным maxRequests, чтобы следующий
      // запрос превысил лимит. Так тест укладывается в один HTTP-вызов
      // вместо 101 — без потери семантики (guard всё равно выполняет
      // INCR + сравнение).
      const key = `ratelimit:user:${admin.id}:GET:/lessons/admin/courses`;
      await redis.set(key, '100');
      await redis.expire(key, 60);

      const res = await adminAuth(
        request(app.getHttpServer()).get('/lessons/admin/courses'),
      ).expect(429);

      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.body).toMatchObject({
        statusCode: 429,
        message: 'Too Many Requests',
      });

      // Очистка: иначе следующий тест словит 429.
      await redis.del(key);
    });
  });

  describe('Сценарий 5b: write без прав', () => {
    it('POST /lessons/admin/courses без JWT → 401', async () => {
      await request(app.getHttpServer())
        .post('/lessons/admin/courses')
        .send({
          slug: 'should-not-create',
          level: 'beginner',
          titleKey: 't',
          descriptionKey: 'd',
        })
        .expect(401);
    });

    it('POST /lessons/admin/courses не-админом → 403', async () => {
      await request(app.getHttpServer())
        .post('/lessons/admin/courses')
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({
          slug: 'should-not-create',
          level: 'beginner',
          titleKey: 't',
          descriptionKey: 'd',
        })
        .expect(403);
    });
  });
});
