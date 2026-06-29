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
import { SYSTEM_EVENT_TYPES } from '@kingside/shared';
import { RedisService } from '../redis/redis.service';
import { EventsPrismaService } from './events-prisma.service';
import { AGG_KEY_PREFIX, Actor } from './events.types';

/**
 * KS-4799 / ADR-152 §6.4. Retention окна `events.actor_events`
 * (pg_partman, заявленные 90 дней). Дублируется в response
 * `GET /me/events`, чтобы фронт показал плашку «история за N дней»
 * и менять retention в коде сервера, не на клиенте.
 */
export const EVENTS_RETENTION_DAYS = 90;

/**
 * KS-4799 / ADR-152 §2.1. Параметры выборки для `listEvents`.
 *
 * `cursor` — уже распарсенный наружу токен (бинарный `(createdAt, id)`).
 * Контроллер обязан валидировать opaque-строку до сервиса; сервис
 * принимает только строго типизированный объект. `id` — `bigint`,
 * соответствует типу PK в `events.actor_events`.
 */
export interface ListEventsCursor {
  createdAt: Date;
  id: bigint;
}

export interface ListEventsOptions {
  cursor?: ListEventsCursor;
  /** 1..100. Контроллер уже привёл к диапазону через DTO + default. */
  limit: number;
  /** Whitelist типов; пусто → все. */
  types?: string[];
  /**
   * `false` (default) — отрезать `SYSTEM_EVENT_TYPES` всегда, даже
   * если `types` явно содержит системный тип. `true` — не отрезать.
   */
  showSystem: boolean;
}

export interface ListEventsItem {
  id: string;            // BigInt → string для JSON-safe сериализации
  type: string;
  payload: unknown;
  created_at: string;    // ISO-8601
}

export interface ListEventsResult {
  items: ListEventsItem[];
  next_cursor: string | null;
  has_more: boolean;
  retention_days: number;
}

interface DeleteResult {
  /** Сколько строк events.actor_events удалено. */
  eventsDeleted: number;
  /** Сколько Redis agg-ключей удалено. */
  aggKeysDeleted: number;
  /**
   * KS-4802. Сколько Redis hints-runtime-ключей удалено
   * (throttle/session/last-page/pending). Эти ключи не относятся к
   * аналитическим агрегатам, но являются приватным runtime-состоянием
   * пользователя для HintsEngine — снимать вместе по тому же
   * GDPR-DELETE.
   */
  hintsKeysDeleted: number;
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
    // KS-4802: runtime-состояние hints (throttle/session/last-page/pending)
    // — приватные данные actor'а, должны зачищаться той же операцией.
    // Иначе после `DELETE /me/analytics-data` глобальная квота показов
    // hints за сегодняшние сутки UTC остаётся и блокирует popover'ы,
    // даже когда `actor_events` уже пустой.
    const hintsKeysDeleted = await this.deleteHintsRuntimeKeys(actor.id);
    return { eventsDeleted, aggKeysDeleted, hintsKeysDeleted };
  }

  /* ─── LIST (Art. 15 — UI «Мои действия», KS-4799 / ADR-152 §2.1) ─ */

  /**
   * Чтение страницы событий actor'а для UI `/me/actions`.
   *
   * Поведение под `EventsPrismaService.getOwner() === null` (dev без
   * events-infra) — пустой ответ, как и `streamExport` / `deleteActorData`:
   * приложение работает, страница просто без данных.
   *
   * Cursor — opaque base64, парсится контроллером ДО сервиса.
   * `items.length > limit` означает «есть следующая страница» —
   * берём `limit+1` и обрезаем последний, чтобы вычислить `has_more`
   * без второго запроса.
   *
   * Использование индекса `(actor_id, type, created_at desc)` из
   * ADR-147 §2.3 — см. ADR-152 §2.1 для разбора planner'ом.
   */
  async listEvents(actor: Actor, opts: ListEventsOptions): Promise<ListEventsResult> {
    const owner = this.prismaSvc.getOwner();
    const empty: ListEventsResult = {
      items: [],
      next_cursor: null,
      has_more: false,
      retention_days: EVENTS_RETENTION_DAYS,
    };
    if (!owner) {
      this.logger.warn(
        `listEvents: EVENTS owner-Prisma не сконфигурирован — пустой ответ (no-op для локали).`,
      );
      return empty;
    }

    const typeFilter = buildTypeFilter(opts.types, opts.showSystem);
    const where: Record<string, unknown> = {
      actorId: actor.id,
      actorType: actor.type,
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(opts.cursor
        ? {
            OR: [
              { createdAt: { lt: opts.cursor.createdAt } },
              { createdAt: opts.cursor.createdAt, id: { lt: opts.cursor.id } },
            ],
          }
        : {}),
    };

    const rows: Array<{
      id: bigint;
      type: string;
      payload: unknown;
      createdAt: Date;
    }> = await owner.actorEvent.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      select: {
        id: true,
        type: true,
        payload: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > opts.limit;
    const visible = hasMore ? rows.slice(0, opts.limit) : rows;

    const items: ListEventsItem[] = visible.map((r) => ({
      id: r.id.toString(),
      type: r.type,
      payload: r.payload,
      created_at: r.createdAt.toISOString(),
    }));

    const nextCursor = hasMore && visible.length > 0
      ? encodeCursor({
          createdAt: visible[visible.length - 1].createdAt,
          id: visible[visible.length - 1].id,
        })
      : null;

    return {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      retention_days: EVENTS_RETENTION_DAYS,
    };
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
   * KS-4802. Чистка приватного runtime-состояния hints для actor'а:
   *   - `hints:throttle:<actor>`     — глобальный 10-минутный lock;
   *   - `hints:session:<actor>:*`    — счётчики показов в сутки UTC;
   *   - `hints:last-page:<actor>`    — кэш последней страницы для DSL;
   *   - `hints:pending:<actor>`      — pending popover'ы (для гостя).
   *
   * Симметрично `deleteAggKeys`: SCAN+DEL для wildcard-пар, прямые DEL
   * для одиночных. Идемпотентно — повторный вызов удалит 0.
   *
   * Ключи захардкожены здесь, а не импортированы из hints.types, чтобы
   * избежать кольцевой зависимости `events → hints`. Сменится префикс —
   * правится в обоих местах (всего 4 строки).
   */
  private async deleteHintsRuntimeKeys(actorId: string): Promise<number> {
    let deleted = 0;
    // Wildcard: hints:session:<actor>:<YYYY-MM-DD> — за каждый день
    // отдельный ключ, удалить надо все.
    try {
      const pattern = `hints:session:${actorId}:*`;
      let cursor = '0';
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
      this.logger.warn(`deleteHintsRuntimeKeys SCAN/DEL failed for ${actorId}: ${msg}`);
    }
    // Одиночные ключи. Каждый отдельным `redis.del` чтобы один невалидный
    // не убил остальные. Игнорируем фактическое число — главное чтобы
    // прошло без throw.
    const singleKeys = [
      `hints:throttle:${actorId}`,
      `hints:last-page:${actorId}`,
      `hints:pending:${actorId}`,
    ];
    for (const key of singleKeys) {
      try {
        deleted += await this.redis.del(key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`deleteHintsRuntimeKeys DEL ${key} failed: ${msg}`);
      }
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

/* ─── KS-4799 cursor + filter helpers (exported для unit-тестов) ─── */

/**
 * Кодирует `(createdAt, id)` пары в opaque base64url-токен. Не
 * подписывается: фильтр `actor_id = req.user.id` зашит на сервере,
 * клиент не может «прыгнуть» в чужие события подменой cursor'а.
 */
export function encodeCursor(c: ListEventsCursor): string {
  const json = JSON.stringify({
    createdAtIso: c.createdAt.toISOString(),
    id: c.id.toString(),
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Парсит cursor. Возвращает `null` если входит null/undefined.
 * Бросает `Error` с понятным message, если строка не парсится — контроллер
 * превратит в 400 BadRequest.
 */
export function decodeCursor(raw: string | undefined | null): ListEventsCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('cursor: invalid base64/JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('cursor: expected JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const iso = obj.createdAtIso;
  const idRaw = obj.id;
  if (typeof iso !== 'string' || typeof idRaw !== 'string') {
    throw new Error('cursor: missing createdAtIso/id');
  }
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error('cursor: createdAtIso is not a valid ISO date');
  }
  let id: bigint;
  try {
    id = BigInt(idRaw);
  } catch {
    throw new Error('cursor: id is not a valid BigInt');
  }
  return { createdAt, id };
}

/**
 * Собирает Prisma-условие для `type` из (types whitelist, showSystem).
 * Логика:
 *   - showSystem=false  + types пуст        → `notIn: SYSTEM_EVENT_TYPES`
 *   - showSystem=false  + types непустой    → `in: types \ SYSTEM_EVENT_TYPES`
 *   - showSystem=true   + types пуст        → undefined (нет фильтра)
 *   - showSystem=true   + types непустой    → `in: types`
 *
 * Пересечение `types ∩ SYSTEM_EVENT_TYPES` при `showSystem=false`
 * сознательно выбрасываем — иначе UI-флаг «скрыть системные» давал
 * бы непредсказуемый результат при ручном указании `types=page_view`.
 *
 * Если после вычитания массив пуст — возвращаем условие, которое
 * заведомо не вернёт строк (`in: []`), а не undefined: иначе мы бы
 * вернули ВСЕ события, что хуже чем «ничего по фильтру».
 */
export function buildTypeFilter(
  types: string[] | undefined,
  showSystem: boolean,
): { in: string[] } | { notIn: readonly string[] } | undefined {
  if (!types || types.length === 0) {
    return showSystem ? undefined : { notIn: SYSTEM_EVENT_TYPES };
  }
  const filtered = showSystem
    ? types
    : types.filter((t) => !SYSTEM_EVENT_TYPES.includes(t));
  return { in: filtered };
}
