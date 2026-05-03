/**
 * KS-2230 e2e — `/api/tactic-drill/*`.
 *
 * Покрытие (по api-contract §5):
 *   1. GET /types — отдаёт 8 типов с metadata.
 *   2. GET /next — 200 + DTO БЕЗ `answer` (api-contract §7); 404 без drill'ов.
 *   3. POST /attempt — гость не пишет; auth → запись в БД, solved/correctAnswer.
 *   4. GET /stats/me — 401 без auth, 200 с auth.
 *   5. POST /sprint/start — 501 (заглушка).
 *
 * AppModule поднимается реальным (Postgres + Redis из apps/api/.env).
 * Перед каждым тестом сбрасываем `tactic_drills` и `tactic_drill_attempts`
 * (специально созданные test-rows), чтобы тесты были изолированными.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';

jest.setTimeout(30_000);

describe('TacticDrill e2e (KS-2230)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testDrillIds: string[] = [];
  const testAttemptIds: string[] = [];
  const testUserIds: string[] = [];

  async function registerUser(prefix: string) {
    const username = `${prefix}_${randomUUID().slice(0, 8)}`;
    const email = `${username}@e2e.local`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ username, email, password: 'Test1234!' })
      .expect(201);
    const token = res.body.accessToken as string;
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    testUserIds.push(payload.sub);
    return { id: payload.sub as string, token, username };
  }

  async function seedDrill(opts: {
    type: string;
    fen: string;
    answer: object;
    difficulty?: number;
  }): Promise<string> {
    // UNIQUE(type, fen) активно — переиспользуем существующую запись
    // через upsert. Если в БД уже есть drill с этой парой
    // (например, в проде успели наинсертиться) — `where`-уникальный
    // ключ найдёт его, а update обновит answer/source. Это безопасно
    // в e2e: чужих рядов с `source='e2e'` нет, конкретные FEN'ы из
    // тестов в индексере не появляются.
    const drill = await prisma.tacticDrill.upsert({
      where: { type_fen: { type: opts.type, fen: opts.fen } },
      update: {
        answer: opts.answer,
        difficulty: opts.difficulty ?? 2,
        source: 'e2e',
      },
      create: {
        type: opts.type,
        fen: opts.fen,
        answer: opts.answer,
        difficulty: opts.difficulty ?? 2,
        source: 'e2e',
      },
      select: { id: true },
    });
    if (!testDrillIds.includes(drill.id)) testDrillIds.push(drill.id);
    return drill.id;
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (testAttemptIds.length > 0) {
      await prisma.tacticDrillAttempt
        .deleteMany({ where: { id: { in: testAttemptIds } } })
        .catch(() => {});
    }
    if (testUserIds.length > 0) {
      // attempts всех пользователей подчистим заодно (FK SET NULL не
      // хватит — userId NULL подвиснет, лучше чисто удалить).
      await prisma.tacticDrillAttempt
        .deleteMany({ where: { userId: { in: testUserIds } } })
        .catch(() => {});
    }
    if (testDrillIds.length > 0) {
      await prisma.tacticDrill
        .deleteMany({ where: { id: { in: testDrillIds } } })
        .catch(() => {});
    }
    if (testUserIds.length > 0) {
      await prisma.user
        .deleteMany({ where: { id: { in: testUserIds } } })
        .catch(() => {});
    }
    if (app) await app.close();
  });

  it('GET /tactic-drill/types → 8 типов с metadata', async () => {
    const res = await request(app.getHttpServer())
      .get('/tactic-drill/types')
      .expect(200);
    expect(res.body.types).toHaveLength(8);
    const fork = (res.body.types as Array<Record<string, unknown>>).find(
      (t) => t.id === 'find-fork',
    );
    expect(fork).toBeDefined();
    expect(fork).toMatchObject({
      id: 'find-fork',
      layer: 'pattern',
      answerShape: 'square',
      promptKey: 'review.drill.prompt.find-fork',
    });
    expect(typeof fork!.unlocked).toBe('boolean');
  });

  it('GET /tactic-drill/next?type=find-fork → 200 + DTO БЕЗ answer', async () => {
    await seedDrill({
      type: 'find-fork',
      fen: 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1',
      answer: { shape: 'square', square: 'c7' },
    });
    const res = await request(app.getHttpServer())
      .get('/tactic-drill/next?type=find-fork')
      .expect(200);
    // critical: api-contract §7 — endpoint не должен раскрывать answer.
    expect(res.body).not.toHaveProperty('answer');
    expect(res.body).toHaveProperty('id');
    expect(res.body.drillType).toBe('find-fork');
    expect(res.body.answerShape).toBe('square');
  });

  it('GET /tactic-drill/next когда задач нет → 404', async () => {
    await request(app.getHttpServer())
      .get('/tactic-drill/next?type=find-loose-piece')
      .expect(404);
  });

  it('POST /tactic-drill/attempt — гость: не пишет в БД, корректный response', async () => {
    const drillId = await seedDrill({
      type: 'find-pin',
      fen: '2k5/2p5/8/8/8/8/8/2RK4 b - - 0 1',
      answer: { shape: 'square', square: 'c7' },
    });
    const before = await prisma.tacticDrillAttempt.count({
      where: { drillId },
    });
    const res = await request(app.getHttpServer())
      .post('/tactic-drill/attempt')
      .send({
        drillId,
        userAnswer: { shape: 'square', square: 'c7' },
        timeMs: 1500,
        mode: 'drill',
      })
      .expect(201);
    expect(res.body.solved).toBe(true);
    expect(res.body.correctAnswer).toEqual({
      shape: 'square',
      square: 'c7',
    });
    const after = await prisma.tacticDrillAttempt.count({
      where: { drillId },
    });
    expect(after).toBe(before); // гость не записал
  });

  it('POST /tactic-drill/attempt — auth: пишет в БД, solved=false', async () => {
    const user = await registerUser('drillu');
    const drillId = await seedDrill({
      type: 'find-fork',
      fen: 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1',
      answer: { shape: 'square', square: 'c7' },
    });
    const res = await request(app.getHttpServer())
      .post('/tactic-drill/attempt')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        drillId,
        userAnswer: { shape: 'square', square: 'a1' }, // неправильно
        timeMs: 2500,
        mode: 'drill',
      })
      .expect(201);
    expect(res.body.solved).toBe(false);
    expect(typeof res.body.attemptId).toBe('string');

    const stored = await prisma.tacticDrillAttempt.findUnique({
      where: { id: res.body.attemptId },
    });
    expect(stored).not.toBeNull();
    if (stored) {
      testAttemptIds.push(stored.id);
      expect(stored.userId).toBe(user.id);
      expect(stored.correct).toBe(false);
      expect(stored.timeMs).toBe(2500);
    }
  });

  it('GET /tactic-drill/stats/me — 401 без auth', async () => {
    await request(app.getHttpServer())
      .get('/tactic-drill/stats/me')
      .expect(401);
  });

  it('GET /tactic-drill/stats/me — 200 с auth + правильная агрегация', async () => {
    const user = await registerUser('drills');
    // Засеиваем 2 drill, делаем 1 правильную, 1 неправильную попытку.
    const dForkId = await seedDrill({
      type: 'find-fork',
      fen: 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1',
      answer: { shape: 'square', square: 'c7' },
    });
    const dPinId = await seedDrill({
      type: 'find-pin',
      fen: '2k5/2p5/8/8/8/8/8/2RK4 b - - 0 1',
      answer: { shape: 'square', square: 'c7' },
    });
    const a1 = await request(app.getHttpServer())
      .post('/tactic-drill/attempt')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        drillId: dForkId,
        userAnswer: { shape: 'square', square: 'c7' },
        timeMs: 1000,
        mode: 'drill',
      })
      .expect(201);
    const a2 = await request(app.getHttpServer())
      .post('/tactic-drill/attempt')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        drillId: dPinId,
        userAnswer: { shape: 'square', square: 'a1' }, // wrong
        timeMs: 3000,
        mode: 'drill',
      })
      .expect(201);
    testAttemptIds.push(a1.body.attemptId, a2.body.attemptId);

    const res = await request(app.getHttpServer())
      .get('/tactic-drill/stats/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.total.attempts).toBe(2);
    expect(res.body.total.solved).toBe(1);
    expect(res.body.byType).toHaveLength(8);
    const fork = res.body.byType.find(
      (b: { drillType: string }) => b.drillType === 'find-fork',
    );
    expect(fork.attempts).toBe(1);
    expect(fork.solved).toBe(1);
    expect(fork.avgTimeMs).toBe(1000);
    expect(res.body.unlocked).toContain('find-fork');
    expect(res.body.unlocked).not.toContain('find-pin');
  });

  it('POST /tactic-drill/sprint/start — 501 (заглушка)', async () => {
    const user = await registerUser('sprint');
    await request(app.getHttpServer())
      .post('/tactic-drill/sprint/start')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ durationMs: 180000, types: [] })
      .expect(501);
  });
});
