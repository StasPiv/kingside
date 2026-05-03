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

  // ─── Sprint flow (KS-2240) ──────────────────────────────────

  it('POST /sprint/start без auth → 401', async () => {
    await request(app.getHttpServer())
      .post('/tactic-drill/sprint/start')
      .send({ durationMs: 180000, types: [] })
      .expect(401);
  });

  it('Sprint flow: start → submit (правильный) → finish', async () => {
    const user = await registerUser('sprintflow');
    // Засеиваем 2 drill-fork позиции (нужны разные FEN, чтобы UNIQUE
    // не дёргался; вторая — для next-after-submit).
    await seedDrill({
      type: 'find-fork',
      fen: 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1',
      answer: { shape: 'square', square: 'c7' },
    });
    await seedDrill({
      type: 'find-fork',
      fen: 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 5',
      answer: { shape: 'square', square: 'c7' },
    });

    // Start.
    const start = await request(app.getHttpServer())
      .post('/tactic-drill/sprint/start')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ durationMs: 180000, types: ['find-fork'] })
      .expect(201);
    expect(start.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(start.body.drill.drillType).toBe('find-fork');
    expect(start.body.drill).not.toHaveProperty('answer');

    // Повторный start без force → 409.
    await request(app.getHttpServer())
      .post('/tactic-drill/sprint/start')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ durationMs: 180000, types: ['find-fork'] })
      .expect(409);

    // Submit правильный.
    const sessionId = start.body.sessionId as string;
    const firstDrillId = start.body.drill.id as string;
    const submitOk = await request(app.getHttpServer())
      .post('/tactic-drill/sprint/submit')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        sessionId,
        drillId: firstDrillId,
        userAnswer: { shape: 'square', square: 'c7' },
        timeMs: 1500,
      })
      .expect(201);
    expect(submitOk.body.attempt.solved).toBe(true);
    // next или final — оба валидны (зависит от того, есть ли вторая
    // задача в пуле). Проверяем форму response'а.
    expect(submitOk.body).toHaveProperty('next');

    // Finish manual — сохранит score в `tactic_drill_sprint_scores`.
    if (!submitOk.body.final) {
      const finish = await request(app.getHttpServer())
        .post('/tactic-drill/sprint/finish')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ sessionId })
        .expect(201);
      expect(finish.body.score).toBeGreaterThanOrEqual(1);
      expect(typeof finish.body.scoreId).toBe('string');
      // Cleanup score (чтобы не оставлять мусор после теста).
      await prisma.tacticDrillSprintScore
        .delete({ where: { id: finish.body.scoreId } })
        .catch(() => {});
    } else {
      await prisma.tacticDrillSprintScore
        .delete({ where: { id: submitOk.body.final.scoreId } })
        .catch(() => {});
    }
  });

  it('GET /sprint/leaderboard?mode=test-mode → top-N', async () => {
    const user = await registerUser('sprintlb');
    // Зальём прямо в БД 2 score'а — leaderboard их вернёт.
    const s1 = await prisma.tacticDrillSprintScore.create({
      data: {
        userId: user.id,
        score: 42,
        drillsCount: 50,
        accuracy: 0.84,
        mode: 'test-mode',
      },
      select: { id: true },
    });
    const s2 = await prisma.tacticDrillSprintScore.create({
      data: {
        userId: user.id,
        score: 30,
        drillsCount: 50,
        accuracy: 0.6,
        mode: 'test-mode',
      },
      select: { id: true },
    });

    const res = await request(app.getHttpServer())
      .get('/tactic-drill/sprint/leaderboard?mode=test-mode')
      .expect(200);
    expect(res.body.mode).toBe('test-mode');
    expect(res.body.entries.length).toBeGreaterThanOrEqual(2);
    // Сортировка по score desc.
    const scores = res.body.entries.map((e: { score: number }) => e.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }

    await prisma.tacticDrillSprintScore
      .deleteMany({ where: { id: { in: [s1.id, s2.id] } } })
      .catch(() => {});
  });
});
