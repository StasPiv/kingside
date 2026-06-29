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
import { Injectable, Logger } from '@nestjs/common';
import { EventsPrismaService } from '../../events/events-prisma.service';
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

export interface HintsDiagnoseResult {
  actor: Actor;
  states: ActorHintStateRow[];
  limits: HintsLimitsState;
}

@Injectable()
export class HintsDiagnoseService {
  private readonly logger = new Logger(HintsDiagnoseService.name);

  constructor(
    private readonly prismaSvc: EventsPrismaService,
    private readonly redis: RedisService,
    private readonly limitsSvc: HintsLimitsService,
  ) {}

  async diagnose(actor: Actor, hintId?: string): Promise<HintsDiagnoseResult> {
    const states = await this.readStates(actor, hintId);
    const limits = await this.readLimitsState(actor);
    return { actor, states, limits };
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
