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
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@kingside/events-db';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { EventsPrismaService } from '../events/events-prisma.service';
import { RedisService } from '../redis/redis.service';
import { HintsService } from '../hints/hints.service';
import { evaluateRule } from '../hints/hints-dsl.evaluator';
import { GuestCookieSigner } from '../common/guest-cookie-signer';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_SIG_COOKIE,
  GUEST_ID_COOKIE,
} from '../events/events.types';
import type { Actor } from '../events/events.types';
import type {
  TestActorDto,
  TestSeedEventDto,
} from './dto/test-seed-events.dto';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

@Injectable()
export class HintsTestService {
  private readonly logger = new Logger(HintsTestService.name);
  private readonly signer: GuestCookieSigner;

  constructor(
    private readonly eventsPrisma: EventsPrismaService,
    private readonly redis: RedisService,
    private readonly hints: HintsService,
    private readonly config: ConfigService,
  ) {
    const secret =
      this.config.get<string>('GUEST_COOKIE_SECRET')
      ?? this.config.get<string>('JWT_SECRET')
      ?? '';
    this.signer = new GuestCookieSigner(secret);
  }

  /**
   * KS-4763 / T6 + KS-4775 / 2c. Прокси к `HintsService.checkFor` с
   * принудительным запуском реактивной цепочки. `checkFor` сам:
   *   - проверяет consent (под `ANALYTICS_CONSENT_BYPASS=1` — bypass),
   *   - оценивает DSL,
   *   - upsert'ит `ActorHintState`,
   *   - для `actor.type='user'` эмитит ws-event `hint:show` через
   *     `MessageGateway`.
   * Нужен e2e suite, т.к. `seedEvents` пишет напрямую в PG, минуя
   * `EventsService.track` → `HintsListener` не дёргается → ws-emit не
   * уходит. `/test/emit-hint` закрывает этот разрыв явно.
   *
   * KS-4775 / 2c. Для guest-actor вручную делаем `RPUSH hints:pending:<id>`
   * с TTL — `HintsService.checkFor` сам RPUSH не делает (это работа
   * `HintsListener.handle`). Без этого pull-loop фронта (`useHintPull`)
   * возвращал пустой список, фикстура была вынуждена обходить через
   * `POST /events page_view`, чтобы реально дёрнуть listener. Теперь
   * один helper покрывает оба actor типа.
   *
   * Возвращает `{ key, emitted }` — `emitted` для user-actor отражает
   * факт ws-emit'а; для guest — факт RPUSH'а в pending-list.
   */
  async emitHint(
    actor: Actor,
    ctx: { page?: string },
  ): Promise<{ key: string | null; emitted: boolean }> {
    const result = await this.hints.checkFor(actor, ctx);
    if (!result) {
      this.logger.log(
        `emitHint: actor=${actor.type}:${actor.id} page=${ctx.page ?? '∅'} → no-match`,
      );
      return { key: null, emitted: false };
    }
    // KS-4775 / 2c. Для гостя RPUSH в pending-list (TTL 60 сек) —
    // совпадает с поведением HintsListener.handle:114-122. Для user
    // ws-emit уже сделал HintsService.checkFor.
    if (actor.type === 'guest') {
      try {
        const key = `hints:pending:${actor.id}`;
        await this.redis.rpush(key, JSON.stringify(result));
        await this.redis.expire(key, 60);
      } catch (err) {
        this.logger.warn(
          `emitHint: RPUSH pending failed for guest=${actor.id}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `emitHint: actor=${actor.type}:${actor.id} page=${ctx.page ?? '∅'} → ${result.key}`,
    );
    return { key: result.key, emitted: true };
  }

  /**
   * KS-4763 / T6+T8. Выпуск signed guest cookies теми же средствами, что
   * `GuestPublicController.consent` и `GuestIdMiddleware`. Используется
   * e2e suite: гостевые сценарии (page=/) требуют валидные
   * `analytics_consent_sig` + `guest_id` cookies — middleware иначе
   * `req.guestId=null`, `POST /events` от гостя падает.
   *
   * Алгоритм идентичен `GuestPublicController.consent({analytics:true})`
   * (см. apps/api/src/guest/guest-public.controller.ts:117-134). Cookies
   * ставятся через `res.append('Set-Cookie', ...)` — Playwright подхватит
   * через browser context на API-origin.
   *
   * KS-4767 / T8. Дополнительно возвращаем в body сами значения cookies
   * (`*_value`). API и фронт в e2e на разных origin'ах (api:3101,
   * web:5174); `Set-Cookie` без `Domain=` ассоциируется только с
   * API-origin, фронт не видит `analytics_consent` через `document.cookie`
   * и `consentGiven` остаётся false. Фикстура использует body+
   * `BrowserContext.addCookies()` чтобы зашить те же значения на
   * frontend-origin. Подпись валидируется backend'ом тем же
   * `GuestCookieSigner` — origin cookie не влияет на проверку HMAC.
   */
  issueGuestCookies(
    res: Response,
    guestIdParam: string | undefined,
  ): {
    guest_id: string;
    expires_in_sec: number;
    cookies: {
      analytics_consent: { name: string; value: string };
      analytics_consent_sig: { name: string; value: string };
      guest_id: { name: string; value: string };
    };
  } {
    const guestId = guestIdParam ?? randomUUID();
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const cookieDomain = this.config.get<string>('COOKIE_DOMAIN') ?? null;

    const consentValue = '1';
    const sig = this.signer.sign(consentValue);
    const guestCookieValue = this.signer.signCombined(guestId);

    setCookie(res, ANALYTICS_CONSENT_COOKIE, consentValue, {
      httpOnly: false, isProduction, cookieDomain,
    });
    setCookie(res, ANALYTICS_CONSENT_SIG_COOKIE, sig, {
      httpOnly: true, isProduction, cookieDomain,
    });
    setCookie(res, GUEST_ID_COOKIE, guestCookieValue, {
      httpOnly: false, isProduction, cookieDomain,
    });

    this.logger.log(`issueGuestCookies: guest_id=${guestId}`);
    return {
      guest_id: guestId,
      expires_in_sec: ONE_YEAR_SECONDS,
      cookies: {
        analytics_consent: { name: ANALYTICS_CONSENT_COOKIE, value: consentValue },
        analytics_consent_sig: { name: ANALYTICS_CONSENT_SIG_COOKIE, value: sig },
        guest_id: { name: GUEST_ID_COOKIE, value: guestCookieValue },
      },
    };
  }

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

/**
 * KS-4763 / T6. Локальный helper построения Set-Cookie. Контракт совпадает
 * с `GuestPublicController.setCookie` (apps/api/src/guest/guest-public.controller.ts:154-172):
 * Max-Age=1y, Path=/, SameSite=Lax, опциональный Domain, Secure под prod.
 */
function setCookie(
  res: Response,
  name: string,
  value: string,
  opts: { httpOnly: boolean; isProduction: boolean; cookieDomain: string | null },
): void {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
  ];
  if (opts.cookieDomain) parts.push(`Domain=${opts.cookieDomain}`);
  if (opts.isProduction) parts.push('Secure');
  if (opts.httpOnly) parts.push('HttpOnly');
  res.append('Set-Cookie', parts.join('; '));
}
