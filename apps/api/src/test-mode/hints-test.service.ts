/**
 * KS-4759 / ADR-150 T1. Сервис тестового режима для hints e2e.
 *
 * Только под `HINTS_TEST_MODE=1` (модуль не подключён в проде).
 * Делает прямые манипуляции с PG/Redis в обход обычного pipeline
 * (XADD → writer → matview), чтобы Playwright-сценарии могли:
 *   - засеивать историю событий с явным `created_at` (backdating),
 *   - чистить актёра между прогонами,
 *   - принудительно обновлять матвью если правила их используют.
 */
import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@kingside/events-db';
import { EventsPrismaService } from '../events/events-prisma.service';
import { RedisService } from '../redis/redis.service';
import { HintsService } from '../hints/hints.service';
import { evaluateRule } from '../hints/hints-dsl.evaluator';
import type { Actor } from '../events/events.types';
import type {
  TestActorDto,
  TestSeedEventDto,
} from './dto/test-seed-events.dto';

@Injectable()
export class HintsTestService {
  private readonly logger = new Logger(HintsTestService.name);

  constructor(
    private readonly eventsPrisma: EventsPrismaService,
    private readonly redis: RedisService,
    private readonly hints: HintsService,
  ) {}

  /**
   * KS-4762 / ADR-150 T4. Прямой proxy к `HintsService.checkFor` для
   * e2e сценариев. Возвращает ключ выбранного hint'а или null.
   * Не пишет в Redis (canShow гейт обходим: тесты ставят throttle=0
   * через HINTS_DEFAULTS_OVERRIDE_JSON), не идёт через event-bus —
   * вызов синхронный.
   */
  async checkFor(
    actor: Actor,
    ctx: { page?: string; triggerEventType?: string },
  ): Promise<{ key: string | null }> {
    const r = await this.hints.checkFor(actor, ctx);
    return { key: r?.key ?? null };
  }

  /**
   * KS-4762 / ADR-150 T4. Эвалюация одного конкретного правила по key.
   * Игнорирует приоритезацию и per-hint лимиты — нужно e2e suite чтобы
   * проверить только DSL `rule` без помех от других active-правил
   * (которые могут иметь больший priority и перебить winner).
   * 404 если правила с таким key нет (или оно disabled/deleted).
   */
  async evaluateRuleByKey(
    actor: Actor,
    ctx: { page?: string },
    key: string,
  ): Promise<{ matched: boolean }> {
    const owner = this.eventsPrisma.getOwner();
    if (!owner) {
      throw new ServiceUnavailableException('EVENTS owner-Prisma not configured');
    }
    const hint = await owner.hint.findFirst({
      where: { key, enabled: true, deletedAt: null },
    });
    if (!hint) {
      throw new NotFoundException(`hint not found: key=${key}`);
    }
    const matched = await evaluateRule(hint.rule as unknown, actor, ctx, {
      events: owner,
    });
    return { matched };
  }

  /**
   * Прямой INSERT в `events.actor_events`. Минует XADD/HintsEngine —
   * слушатели listener'ы не дёргаются на эти записи (history backdating
   * не должен триггерить попапы заранее).
   */
  async seedEvents(actor: TestActorDto, events: TestSeedEventDto[]): Promise<{ inserted: number }> {
    const owner = this.eventsPrisma.getOwner();
    if (!owner) {
      throw new ServiceUnavailableException('EVENTS owner-Prisma not configured');
    }
    const data: Prisma.ActorEventCreateManyInput[] = events.map((e) => ({
      actorId: actor.id,
      actorType: actor.type,
      type: e.type,
      payload: (e.payload ?? {}) as Prisma.InputJsonValue,
      createdAt: new Date(e.created_at),
    }));
    const res = await owner.actorEvent.createMany({ data });
    this.logger.log(
      `seedEvents: actor=${actor.type}:${actor.id} inserted=${res.count}`,
    );
    return { inserted: res.count };
  }

  /**
   * Полная очистка состояния актёра:
   *   - `events.actor_events` (вся история),
   *   - `events.actor_hint_states` (showed/dismissed/suppressed),
   *   - Redis: `hints:throttle:<id>`, `hints:session:<id>:*`,
   *     `hints:pending:<id>` (guest), `hints:last-page:<id>`.
   *
   * fail-soft: если owner-Prisma не настроен, бросает 503 — это знак
   * что test-окружение не сконфигурировано.
   */
  async cleanActor(actor: TestActorDto): Promise<{
    eventsDeleted: number;
    statesDeleted: number;
    redisKeysDeleted: number;
  }> {
    const owner = this.eventsPrisma.getOwner();
    if (!owner) {
      throw new ServiceUnavailableException('EVENTS owner-Prisma not configured');
    }
    const [eventsRes, statesRes] = await Promise.all([
      owner.actorEvent.deleteMany({
        where: { actorId: actor.id, actorType: actor.type },
      }),
      owner.actorHintState.deleteMany({
        where: { actorId: actor.id, actorType: actor.type },
      }),
    ]);

    // Redis: SCAN+DEL по префиксам — у session ключи c суффиксом даты.
    const patterns = [
      `hints:throttle:${actor.id}`,
      `hints:session:${actor.id}:*`,
      `hints:pending:${actor.id}`,
      `hints:last-page:${actor.id}`,
    ];
    let redisDeleted = 0;
    for (const p of patterns) {
      if (p.includes('*')) {
        const keys = await this.scanKeys(p);
        if (keys.length > 0) {
          redisDeleted += await this.redis.del(...keys);
        }
      } else {
        redisDeleted += await this.redis.del(p);
      }
    }
    this.logger.log(
      `cleanActor: actor=${actor.type}:${actor.id} events=${eventsRes.count} states=${statesRes.count} redis=${redisDeleted}`,
    );
    return {
      eventsDeleted: eventsRes.count,
      statesDeleted: statesRes.count,
      redisKeysDeleted: redisDeleted,
    };
  }

  /**
   * REFRESH всех `actor_event_counts_*` матвью (если используются
   * правилами с длинными окнами). Прямой `evaluateCount` идёт по
   * raw-таблице, поэтому матвью для DSL не критичны — но если в
   * будущем правила переедут на матвью, тестовый прогон должен
   * иметь возможность их пнуть.
   */
  async refreshMatviews(): Promise<{ refreshed: string[] }> {
    const owner = this.eventsPrisma.getOwner();
    if (!owner) {
      throw new ServiceUnavailableException('EVENTS owner-Prisma not configured');
    }
    const views = [
      'events.actor_event_counts_24h',
      'events.actor_event_counts_7d',
      'events.actor_event_counts_30d',
    ];
    const refreshed: string[] = [];
    for (const view of views) {
      try {
        // CONCURRENTLY чтобы не блокировать SELECT'ы соседних тестов.
        await owner.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
        refreshed.push(view);
      } catch (err) {
        // Матвью может ещё не существовать в test-окружении — это ок.
        this.logger.warn(
          `refreshMatviews: ${view} skipped: ${(err as Error).message}`,
        );
      }
    }
    return { refreshed };
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }
}
