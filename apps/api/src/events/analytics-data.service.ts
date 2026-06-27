/**
 * KS-4697 / ADR-147 §6.3 + §1.1. Общая логика GDPR-операций
 * над analytics-данными actor'а (user или guest):
 *
 *   - `deleteActorData(actor)` — Art. 17 (право на удаление):
 *     DELETE из `events.actor_events` + `actor_hint_states`
 *     (когда последняя появится в T6) + SCAN+DEL Redis-counters
 *     `agg:<actor_id>:*`. PEL Stream-entries для actor'а — best-effort
 *     не трогаются (writer обработает и сразу удалит после следующего
 *     refresh: операция идемпотентна).
 *   - `exportActorData(actor)` — Art. 20 (портативность): возвращает
 *     поток строк (массив объектов) для `actor_events` и stub-список
 *     `actor_hint_states`. JSON-стримим вручную в контроллере, чтобы
 *     не материализовывать всё в память.
 *   - `mergeGuestToUser({guestId, userId})` — §1.1: переключает
 *     `actor_id+actor_type` гостевых событий на нового пользователя
 *     в одной транзакции owner-Prisma, копирует agg-ключи Redis.
 *     Идемпотентно: на повторе с тем же guestId UPDATE затронет 0 строк.
 *
 * `events`-таблица живёт в отдельной schema под учёткой `events_writer`
 * (INSERT/SELECT) и `EVENTS_DATABASE_URL` owner (UPDATE/DELETE/refresh).
 * Operations здесь — DELETE/UPDATE — идут через owner-PrismaClient
 * (`EventsPrismaService.getOwner()`); writer-роль их не разрешит.
 *
 * Если EventsPrismaService.getOwner() === null (нет env, локаль) —
 * операции no-op (логируем warn). Это разумно: на dev без events-infra
 * нечего удалять.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient as EventsPrismaClient } from '@kingside/events-db';
import { RedisService } from '../redis/redis.service';
import { EventsPrismaService } from './events-prisma.service';
import { AGG_KEY_PREFIX, Actor } from './events.types';

interface DeleteResult {
  /** Сколько строк events.actor_events удалено. */
  eventsDeleted: number;
  /** Сколько Redis agg-ключей удалено. */
  aggKeysDeleted: number;
}

interface MergeResult {
  /** Сколько строк events.actor_events переписано на user. */
  eventsMigrated: number;
  /** Сколько Redis agg-ключей перенесено. */
  aggKeysMigrated: number;
}

@Injectable()
export class AnalyticsDataService {
  private readonly logger = new Logger(AnalyticsDataService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prismaSvc: EventsPrismaService,
  ) {}

  /* ─── DELETE (Art. 17) ─────────────────────────────────────── */

  async deleteActorData(actor: Actor): Promise<DeleteResult> {
    const owner = this.prismaSvc.getOwner();
    let eventsDeleted = 0;
    if (owner) {
      try {
        const r = await owner.actorEvent.deleteMany({
          where: { actorId: actor.id, actorType: actor.type },
        });
        eventsDeleted = r.count;
        // KS-4699 / ADR-147 §3.1: actor_hint_states тоже относится к
        // приватным данным actor'а — удаляем тем же запросом.
        await owner.actorHintState.deleteMany({
          where: { actorId: actor.id, actorType: actor.type },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`deleteActorData PG failed for ${actor.type}=${actor.id}: ${msg}`);
      }
    } else {
      this.logger.warn(
        `deleteActorData: EVENTS owner-Prisma не сконфигурирован — PG-DELETE пропущен (no-op для локали).`,
      );
    }

    const aggKeysDeleted = await this.deleteAggKeys(actor.id);
    return { eventsDeleted, aggKeysDeleted };
  }

  /* ─── EXPORT (Art. 20) ─────────────────────────────────────── */

  /**
   * Возвращает async-generator строк JSON для одной плоской структуры:
   *   `{ schema_version, exported_at, actor, actor_events: [...], actor_hint_states: [] }`
   *
   * Контроллер обвязывает её в `res.write(...)` чанками, чтобы держать
   * память O(1) на больших экспортах.
   */
  async *streamExport(
    actor: Actor,
    nowIso: string,
  ): AsyncGenerator<string> {
    const owner = this.prismaSvc.getOwner();
    yield `{"schema_version":1,"exported_at":${JSON.stringify(nowIso)},"actor":${JSON.stringify(actor)},"actor_events":[`;

    if (owner) {
      let first = true;
      // Пагинация cursor-based по `id` (composite PK включает createdAt,
      // но id монотонный — этого хватает для стабильного перебора).
      const PAGE = 500;
      let lastId: bigint | null = null;
      while (true) {
        const rows: Array<{
          id: bigint;
          type: string;
          payload: unknown;
          createdAt: Date;
        }> = await owner.actorEvent.findMany({
          where: {
            actorId: actor.id,
            actorType: actor.type,
            ...(lastId ? { id: { gt: lastId } } : {}),
          },
          orderBy: { id: 'asc' },
          take: PAGE,
          select: {
            id: true,
            type: true,
            payload: true,
            createdAt: true,
          },
        });
        if (rows.length === 0) break;
        for (const r of rows) {
          if (!first) yield ',';
          first = false;
          yield JSON.stringify({
            id: r.id.toString(),
            type: r.type,
            payload: r.payload,
            created_at: r.createdAt.toISOString(),
          });
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < PAGE) break;
      }
    }
    // KS-4699: actor_hint_states — состояние подсказок для actor'а.
    yield '],"actor_hint_states":[';
    if (owner) {
      try {
        const states = await owner.actorHintState.findMany({
          where: { actorId: actor.id, actorType: actor.type },
          select: {
            hintId: true,
            shownCount: true,
            lastShownAt: true,
            dismissedAt: true,
            actedAt: true,
            suppressedUntil: true,
          },
        });
        for (let i = 0; i < states.length; i++) {
          if (i > 0) yield ',';
          const s = states[i];
          yield JSON.stringify({
            hint_id: s.hintId,
            shown_count: s.shownCount,
            last_shown_at: s.lastShownAt?.toISOString() ?? null,
            dismissed_at: s.dismissedAt?.toISOString() ?? null,
            acted_at: s.actedAt?.toISOString() ?? null,
            suppressed_until: s.suppressedUntil?.toISOString() ?? null,
          });
        }
      } catch (err) {
        this.logger.warn(`streamExport actor_hint_states failed: ${(err as Error).message}`);
      }
    }
    yield ']}';
  }

  /* ─── MERGE guest → user (§1.1) ────────────────────────────── */

  async mergeGuestToUser(args: {
    guestId: string;
    userId: string;
  }): Promise<MergeResult> {
    const { guestId, userId } = args;
    const owner = this.prismaSvc.getOwner();
    let eventsMigrated = 0;

    if (owner) {
      try {
        await owner.$transaction(async (tx) => {
          const r = await tx.actorEvent.updateMany({
            where: { actorId: guestId, actorType: 'guest' },
            data: { actorId: userId, actorType: 'user' },
          });
          eventsMigrated = r.count;
          // KS-4699 / ADR-147 §1.1: перенос ActorHintState под нового
          // user'а. Композитный PK `(actor_id, hint_id)` — если у нового
          // user уже есть запись по тому же hint (теоретически
          // невозможно — он только что создан), updateMany упадёт по
          // unique constraint. На практике — fresh user, конфликта нет.
          await tx.actorHintState.updateMany({
            where: { actorId: guestId, actorType: 'guest' },
            data: { actorId: userId, actorType: 'user' },
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`mergeGuestToUser PG failed (${guestId}→${userId}): ${msg}`);
      }
    } else {
      this.logger.warn(
        `mergeGuestToUser: EVENTS owner-Prisma не сконфигурирован — PG-merge пропущен.`,
      );
    }

    const aggKeysMigrated = await this.copyAggKeys(guestId, userId);
    return { eventsMigrated, aggKeysMigrated };
  }

  /* ─── Redis helpers ────────────────────────────────────────── */

  /**
   * SCAN + DEL по ключам `agg:<actor_id>:*`. Возвращает число удалённых.
   * Идемпотентно: повторный вызов — 0.
   */
  private async deleteAggKeys(actorId: string): Promise<number> {
    const pattern = `${AGG_KEY_PREFIX}${actorId}:*`;
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const reply = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = String(reply[0]);
        const keys = reply[1] as string[];
        if (keys.length > 0) {
          deleted += await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`deleteAggKeys SCAN/DEL failed for ${actorId}: ${msg}`);
    }
    return deleted;
  }

  /**
   * SCAN + RENAME для каждого `agg:<guestId>:*` → `agg:<userId>:*`.
   * Если ключ `agg:<userId>:<...>` уже существует (race / повторный
   * merge) — берём максимум, не теряем счётчик: `INCRBY` от guest-value,
   * затем `DEL guest`.
   *
   * Идемпотентно: если у guest ключей уже нет (пред. merge сделал DEL) —
   * возвращает 0.
   */
  private async copyAggKeys(guestId: string, userId: string): Promise<number> {
    const pattern = `${AGG_KEY_PREFIX}${guestId}:*`;
    let cursor = '0';
    let migrated = 0;
    try {
      do {
        const reply = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = String(reply[0]);
        const keys = reply[1] as string[];
        for (const guestKey of keys) {
          const userKey = guestKey.replace(
            `${AGG_KEY_PREFIX}${guestId}:`,
            `${AGG_KEY_PREFIX}${userId}:`,
          );
          const value = await this.redis.get(guestKey);
          if (value !== null) {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              // INCRBY чтобы не затирать существующий user-counter
              // (например, если пользователь уже был залогинен с того же
              // браузера — теоретически невозможно, но безопаснее).
              const ttl = await this.redis.ttl(guestKey);
              await this.redis.incrby(userKey, n);
              if (ttl > 0) {
                await this.redis.expire(userKey, ttl);
              }
              migrated += 1;
            }
            await this.redis.del(guestKey);
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`copyAggKeys SCAN failed (${guestId}→${userId}): ${msg}`);
    }
    return migrated;
  }
}
