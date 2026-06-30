/**
 * KS-4803. Диагностический read-only сервис для hints-pipeline.
 * Симметричен `AnalyticsDataService.listEvents`, но смотрит другие
 * источники:
 *
 *   1. `events.actor_hint_states` (через owner-Prisma из
 *      `EventsPrismaService`) — состояние показов hints для actor'а.
 *      Опционально джойнится с `events.hints` чтобы вернуть `key`
 *      каждого hint'а (читателю удобнее, чем гонять второй запрос).
 *   2. Redis-gate `hints:throttle:<actor>` + `hints:session:<actor>:<date>`
 *      — глобальные лимиты `HintsLimitsService.canShow` (rate-limit
 *      10 мин + квота показов в сутки UTC).
 *
 * Не оценивает DSL, не модифицирует состояние. Используется только
 * сервис-аккаунтом со scope `hints:read` для диагностики «почему
 * popover не дошёл / откуда лимит».
 */
import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { EventsPrismaService } from '../../events/events-prisma.service';
import { MessageGateway } from '../../message/message.gateway';
import { RedisService } from '../../redis/redis.service';
import { HintsLimitsService } from '../hints-limits.service';
import {
  sessionCounterKey,
  throttleKey,
  todayUtc,
} from '../hints.types';
import type { Actor } from '../../events/events.types';

export interface ActorHintStateRow {
  hint_id: string;
  hint_key: string | null;
  hint_enabled: boolean | null;
  shown_count: number;
  last_shown_at: string | null;
  shown_ack_at: string | null;
  dismissed_at: string | null;
  acted_at: string | null;
  suppressed_until: string | null;
}

export interface HintsLimitsState {
  throttle: {
    key: string;
    exists: boolean;
    /** `-2` — ключа нет, `-1` — без TTL, иначе секунды до истечения. */
    ttl_sec: number;
  };
  session: {
    key: string;
    /** Текущее значение счётчика; `0` если ключа нет. */
    count: number;
    ttl_sec: number;
  };
  /** Текущие конфиг-лимиты для контекста. */
  config: {
    session_max_shows: number;
    global_throttle_sec: number;
    enabled: boolean;
  };
}

/**
 * KS-4814. Срез состояния Socket.IO rooms по двум namespace'ам —
 * чтобы отличить «сокет вообще не joined» от «сокет joined, но в
 * другом namespace».
 */
export interface RoomInspection {
  room: string;
  root_size: number;
  messages_size: number;
  root_total_rooms: number;
  messages_total_rooms: number;
  messages_ns_sockets?: number;
  engine_clients_total?: number;
  messages_fetch_sockets_count?: number;
  messages_fetch_socket_ids?: string[];
  server_constructor_name?: string;
  server_name?: string | null;
  direct_adapter_rooms_size?: number;
  direct_adapter_room_size?: number;
  direct_fetch_sockets_count?: number;
  direct_fetch_socket_ids?: string[];
}

export interface HintsDiagnoseResult {
  actor: Actor;
  states: ActorHintStateRow[];
  limits: HintsLimitsState;
  room?: RoomInspection;
}

@Injectable()
export class HintsDiagnoseService {
  private readonly logger = new Logger(HintsDiagnoseService.name);

  constructor(
    private readonly prismaSvc: EventsPrismaService,
    private readonly redis: RedisService,
    private readonly limitsSvc: HintsLimitsService,
    // KS-4814. MessageGateway инжектируется через forwardRef — он сам
    // зависит от HintsService (replayPending). @Optional — spec-фикстуры
    // и юниты без MessageModule.
    @Optional()
    @Inject(forwardRef(() => MessageGateway))
    private readonly gateway?: MessageGateway,
  ) {}

  async diagnose(actor: Actor, hintId?: string): Promise<HintsDiagnoseResult> {
    const states = await this.readStates(actor, hintId);
    const limits = await this.readLimitsState(actor);
    const room = this.gateway ? await this.gateway.inspectRoom(actor.id) : undefined;
    return { actor, states, limits, ...(room ? { room } : {}) };
  }

  /**
   * KS-4810 follow-up. Снять текущий throttle (10-мин блок) и
   * session-counter (квота показов в сутки) для конкретного actor'а.
   * Не трогает `events.actor_hint_states` (per-hint maxShows/cooldown
   * остаются), не трогает `events.actor_events`. Возвращает число
   * удалённых ключей (0..2 + session-патитиции по разным дням).
   */
  /**
   * KS-4818 diag. Синтетический `hint:show` в room `user:<actor.id>`
   * через `MessageGateway.emitHintShow`. Полностью изолирован: DSL не
   * вызывается, `actor_hint_states` не правится, throttle/session не
   * меняются. Возвращает `delivered` (был ли локально живой сокет в
   * этой room в момент вызова) и сам synthetic payload — чтобы клиент
   * мог сопоставить значения в DevTools.
   */
  async testEmit(actor: Actor): Promise<{
    delivered: boolean;
    room: string;
    size: number;
    payload: unknown;
  }> {
    const room = `user:${actor.id}`;
    const payload = {
      hintId: 'diag-test',
      key: 'diag-test',
      locale: 'ru',
      title: 'Diagnostic ping',
      body: 'KS-4818 synthetic hint:show — если виден, WS-канал рабочий',
      ctaLabel: null,
      ctaHref: null,
      ctaEvent: null,
      anchor: 'diag-test',
      placement: 'top',
      ttlSec: 5,
    };
    if (!this.gateway) {
      return { delivered: false, room, size: 0, payload };
    }
    const inspect = await this.gateway.inspectRoom(actor.id);
    const size = inspect.direct_adapter_room_size ?? 0;
    const result = this.gateway.emitHintShow(actor.id, payload, actor.type);
    return { delivered: !!result?.delivered || size > 0, room, size, payload };
  }

  async resetLimits(actor: Actor): Promise<{ keys_deleted: number }> {
    let deleted = 0;
    // throttle — один ключ.
    try {
      deleted += await this.redis.del(`hints:throttle:${actor.id}`);
    } catch (err) {
      this.logger.warn(
        `resetLimits DEL throttle failed for ${actor.type}:${actor.id}: ${(err as Error).message}`,
      );
    }
    // session-counter — SCAN по pattern hints:session:<actor>:*
    // (на случай, если есть запись за прошлые сутки UTC).
    try {
      const pattern = `hints:session:${actor.id}:*`;
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
      this.logger.warn(
        `resetLimits SCAN/DEL session failed for ${actor.type}:${actor.id}: ${(err as Error).message}`,
      );
    }
    return { keys_deleted: deleted };
  }

  /**
   * Читает `events.actor_hint_states` через owner-Prisma. Если
   * `EVENTS_DATABASE_URL` не сконфигурирован (dev без events-infra) —
   * возвращает пустой массив, симметрично `analytics-data.service.ts`.
   *
   * Джойн с `events.hints` через отдельный `findMany` по id — таблиц
   * мало, hintId-список конечный, planner делает index-lookup.
   */
  private async readStates(actor: Actor, hintId?: string): Promise<ActorHintStateRow[]> {
    const owner = this.prismaSvc.getOwner();
    if (!owner) {
      this.logger.warn(
        `diagnose: EVENTS owner-Prisma не сконфигурирован — states пустой.`,
      );
      return [];
    }
    const where: Record<string, unknown> = {
      actorId: actor.id,
      actorType: actor.type,
    };
    if (hintId) where.hintId = hintId;

    const rows = await owner.actorHintState.findMany({
      where: where as never,
      orderBy: { lastShownAt: 'desc' },
      select: {
        hintId: true,
        shownCount: true,
        lastShownAt: true,
        shownAckAt: true,
        dismissedAt: true,
        actedAt: true,
        suppressedUntil: true,
      },
    });
    if (rows.length === 0) return [];

    const hints = await owner.hint.findMany({
      where: { id: { in: rows.map((r) => r.hintId) } },
      select: { id: true, key: true, enabled: true },
    });
    const hintById = new Map(hints.map((h) => [h.id, h]));

    return rows.map((r) => {
      const h = hintById.get(r.hintId);
      return {
        hint_id: r.hintId,
        hint_key: h?.key ?? null,
        hint_enabled: h?.enabled ?? null,
        shown_count: r.shownCount,
        last_shown_at: r.lastShownAt?.toISOString() ?? null,
        shown_ack_at: r.shownAckAt?.toISOString() ?? null,
        dismissed_at: r.dismissedAt?.toISOString() ?? null,
        acted_at: r.actedAt?.toISOString() ?? null,
        suppressed_until: r.suppressedUntil?.toISOString() ?? null,
      };
    });
  }

  /**
   * Снимает Redis-состояние двух ключей gate'а + текущий конфиг.
   * Fail-soft: при ошибке Redis возвращаем «exists=false / count=0 /
   * ttl=-2», чтобы вызов не падал по сети.
   */
  private async readLimitsState(actor: Actor): Promise<HintsLimitsState> {
    const tKey = throttleKey(actor.id);
    const sKey = sessionCounterKey(actor.id, todayUtc());
    const config = this.limitsSvc.getLimits();
    const out: HintsLimitsState = {
      throttle: { key: tKey, exists: false, ttl_sec: -2 },
      session: { key: sKey, count: 0, ttl_sec: -2 },
      config: {
        session_max_shows: config.sessionMaxShows,
        global_throttle_sec: config.globalThrottleSec,
        enabled: config.enabled,
      },
    };
    try {
      const [tExists, tTtl, sValue, sTtl] = await Promise.all([
        this.redis.exists(tKey),
        this.redis.ttl(tKey),
        this.redis.get(sKey),
        this.redis.ttl(sKey),
      ]);
      out.throttle.exists = tExists === 1;
      out.throttle.ttl_sec = tTtl;
      const n = sValue ? Number.parseInt(sValue, 10) : 0;
      out.session.count = Number.isFinite(n) ? n : 0;
      out.session.ttl_sec = sTtl;
    } catch (err) {
      this.logger.warn(
        `readLimitsState Redis-fail for ${actor.type}:${actor.id}: ${(err as Error).message}`,
      );
    }
    return out;
  }
}
