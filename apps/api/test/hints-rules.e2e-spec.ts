/**
 * KS-4762 / ADR-150 T4. E2E-spec для всех активных hints-правил.
 *
 * Принцип:
 *   1. Подключается реальный AppModule (с включённым HintsTestModule —
 *      env-vars выставляются в `setup-e2e-env.ts`).
 *   2. Для каждой фикстуры (по одной на правило):
 *      - cleanActor — стираем историю фикстурного actor'а;
 *      - matches: seed → evaluateRuleByKey → ожидаем true;
 *      - noMatch: cleanActor → seed → evaluateRuleByKey → ожидаем false.
 *   3. Используется `POST /test/evaluate-rule` (KS-4762), который
 *      эвалюирует ровно одно правило по key — без приоритезации
 *      checkFor и per-hint лимитов. Это изолирует тест от соседних
 *      правил, у которых может быть выше priority.
 *
 * Требуется:
 *   - Доступная PostgreSQL с применёнными миграциями events-схемы.
 *   - Доступный Redis.
 *   - Заранее загруженные правила в `events.hints` (через admin API
 *     либо seed-фикстуру docker-compose из T3).
 *
 * Если какое-то правило отсутствует в БД — соответствующий describe
 * выдаст 404 от evaluate-rule, тест явно укажет на отсутствующее
 * правило (это не флаки, это проблема окружения).
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { json } from 'express';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { FIXTURES, type RuleFixture } from './hints-fixtures';

jest.setTimeout(60_000);

describe('Hints rules e2e (KS-4762)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    // bodyParser с verify — нужен InternalEventsGuard, не критично здесь.
    app.use(json({ limit: '1mb' }));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // Один UUID на всю фикстуру: между тестами cleanActor стирает
  // историю — не надо новый id на каждый кейс.
  function makeActor(type: 'user' | 'guest'): { type: 'user' | 'guest'; id: string } {
    return { type, id: randomUUID() };
  }

  async function clean(actor: { type: string; id: string }): Promise<void> {
    await request(server)
      .post('/test/clean-actor')
      .send({ actor })
      .expect(200);
  }

  async function seed(
    actor: { type: string; id: string },
    events: RuleFixture['matches']['events'],
  ): Promise<void> {
    if (events.length === 0) return;
    await request(server)
      .post('/test/seed/events')
      .send({ actor, events })
      .expect(200);
  }

  async function evaluate(
    actor: { type: string; id: string },
    page: string,
    key: string,
  ): Promise<boolean> {
    const res = await request(server)
      .post('/test/evaluate-rule')
      .send({ actor, page, key })
      .expect(200);
    return Boolean(res.body.matched);
  }

  describe.each(FIXTURES)('rule: $key', (fx: RuleFixture) => {
    let actor: { type: 'user' | 'guest'; id: string };

    beforeEach(async () => {
      actor = makeActor(fx.actorType);
      await clean(actor);
    });

    afterEach(async () => {
      await clean(actor);
    });

    it('matches: правило срабатывает при ожидаемых events + page', async () => {
      await seed(actor, fx.matches.events);
      const matched = await evaluate(actor, fx.matches.page, fx.key);
      expect(matched).toBe(true);
    });

    it('noMatch: ослабленные условия → правило не срабатывает', async () => {
      await seed(actor, fx.noMatch.events);
      const matched = await evaluate(actor, fx.noMatch.page, fx.key);
      expect(matched).toBe(false);
    });
  });
});
