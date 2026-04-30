/**
 * KS-2164. Управляет «онлайн-состоянием» synthetic-юзеров: отметка
 * `User.lastSeenAt`, разделение на idle/polling-pool, цикл
 * `idle → in_queue → in_game → idle`.
 *
 * Источник истины состояний — Redis:
 *   - `synthetic:state:<userId>` String: `'idle' | 'in_queue' | 'in_game'`.
 *   - `synthetic:in_queue:<cat>` Set userId'ов в очереди категории.
 *   - `synthetic:roster:idle`   Set всех синтетов в idle (для polling-pool sample).
 *
 * Polling-pool (40% по дефолту, ADR §4.2): подмножество синтетов,
 * которые сами ходят в очередь с jitter-интервалом 30..120 сек —
 * создают «реалистичный трафик» в lobby. В этой версии распределение
 * idle vs polling выбирается случайно при первой регистрации синтета
 * (детерминированный coin-flip по hash(userId) — переживает рестарт
 * без отдельного хранения).
 *
 * Сервис НЕ запускает scheduler-tick (это `SyntheticSchedulerService`)
 * и НЕ делает прямых модификаций `matchmaking:<cat>` ZSET — он
 * вызывает `MatchmakingService.joinQueue` / `leaveQueue` через DI.
 *
 * Опт-ин через env `SYNTHETIC_SCHEDULER_ENABLED`. Без флага сервис
 * idle: onModuleInit лог пишет, никакие таймеры не запускаются.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { SyntheticEnvKey } from '@kingside/shared';
import type { LiveQueueCategory } from './live-queue-stats';
import {
  syntheticInQueueKey,
} from './live-queue-stats';
import type { SyntheticDeps, SyntheticPrisma, SyntheticRedis } from './synthetic-deps';

const DEFAULT_PRESENCE_TICK_MS = 60_000;
const DEFAULT_POLLING_MIN_MS = 30_000;
const DEFAULT_POLLING_MAX_MS = 120_000;

/**
 * 40% синтетов попадают в polling-pool. Выбор детерминирован по
 * sha256(userId) — без отдельного хранения переживает рестарт.
 * Возвращает [0..100), в polling-пул попадают со значением < 40.
 */
export function userPollingBucket(userId: string): number {
  const hash = createHash('sha256').update(userId).digest();
  // Берём первые 4 байта, сводим к [0..100).
  const v = hash.readUInt32BE(0);
  return v % 100;
}

export function isPollingUser(
  userId: string,
  pollingPercent: number = 40,
): boolean {
  return userPollingBucket(userId) < pollingPercent;
}

/** Канонические time-control пары для category (центр диапазона). */
export const CANONICAL_TIME_CONTROL: Record<
  LiveQueueCategory,
  { initial: number; increment: number }
> = {
  bullet: { initial: 60, increment: 0 },
  blitz: { initial: 300, increment: 3 },
  rapid: { initial: 600, increment: 5 },
  classical: { initial: 1800, increment: 0 },
};

export type SyntheticState = 'idle' | 'in_queue' | 'in_game';

function stateKey(userId: string): string {
  return `synthetic:state:${userId}`;
}

const ROSTER_IDLE_KEY = 'synthetic:roster:idle';

/**
 * Узкий API matchmaking-сервиса, нужный presence (через DI).
 */
export interface MatchmakingApi {
  joinQueue(
    userId: string,
    timeInitialSec: number,
    timeIncrementSec: number,
    isOnline?: (userId: string) => Promise<boolean>,
    ratingFilter?: { ratingDelta?: number },
  ): Promise<unknown>;
  leaveQueue(userId: string, category: LiveQueueCategory): Promise<unknown>;
}

@Injectable()
export class SyntheticPresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyntheticPresenceService.name);
  private presenceTimer: NodeJS.Timeout | null = null;
  private pollingTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private deps: SyntheticDeps | null = null;
  private matchmaking: MatchmakingApi | null = null;

  /**
   * `setDeps` вызывает модуль при сборке DI; вынесли наружу, потому что
   * сервис тестируется без NestJS — собирается напрямую.
   */
  configure(deps: SyntheticDeps, matchmaking: MatchmakingApi): void {
    this.deps = deps;
    this.matchmaking = matchmaking;
  }

  async onModuleInit(): Promise<void> {
    if (process.env[SyntheticEnvKey.SchedulerEnabled] !== 'true') {
      this.logger.log(
        `${SyntheticEnvKey.SchedulerEnabled} != "true" — synthetic presence disabled`,
      );
      return;
    }
    if (!this.deps || !this.matchmaking) {
      this.logger.warn(
        'SyntheticPresenceService: configure() not called — module integration broken',
      );
      return;
    }
    this.startPresenceTick();
    await this.refreshRoster();
    this.startPollingScheduler();
    this.logger.log(
      `synthetic presence started: presence-tick=${this.presenceTickMs()}ms ` +
        `polling-jitter=[${this.pollingMinMs()}..${this.pollingMaxMs()}]ms`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    for (const t of this.pollingTimers.values()) clearTimeout(t);
    this.pollingTimers.clear();
  }

  // ─── Конфиг (env override) ─────────────────────────────────────────

  private envInt(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }
  private presenceTickMs(): number {
    return this.envInt(SyntheticEnvKey.PresenceTickMs, DEFAULT_PRESENCE_TICK_MS);
  }
  private pollingMinMs(): number {
    return this.envInt(
      SyntheticEnvKey.PollingIntervalMinMs,
      DEFAULT_POLLING_MIN_MS,
    );
  }
  private pollingMaxMs(): number {
    return this.envInt(
      SyntheticEnvKey.PollingIntervalMaxMs,
      DEFAULT_POLLING_MAX_MS,
    );
  }

  // ─── Idle/polling roster sync ──────────────────────────────────────

  /**
   * Загружает в `synthetic:roster:idle` всех synthetic'ов из БД,
   * которые сейчас в state=idle (или у которых state не выставлен —
   * считаем idle по умолчанию). Раз в час перечитываем — на случай
   * добавления новых synthetic'ов через KS-2162 seed.
   */
  async refreshRoster(): Promise<void> {
    if (!this.deps) return;
    const synthetics = await this.deps.prisma.user.findMany({
      where: { isSynthetic: true },
      select: { id: true },
    });
    if (synthetics.length === 0) {
      this.logger.warn('synthetic roster: 0 synthetic users in DB');
      return;
    }
    const ids = synthetics.map((u) => u.id);
    // Идемпотентно: SADD не дублирует.
    await this.deps.redis.sadd(ROSTER_IDLE_KEY, ...ids).catch(() => 0);
    this.logger.log(`synthetic roster refreshed: ${ids.length} ids`);
  }

  /**
   * Тиковый апдейт `User.lastSeenAt` для всех в idle/in_queue/in_game.
   * «Online» = state ≠ undefined. Дёшево: один UPDATE по всему idle-roster'у.
   */
  private startPresenceTick(): void {
    const tick = async () => {
      if (this.stopped || !this.deps) return;
      try {
        const ids = await this.deps.redis.smembers(ROSTER_IDLE_KEY);
        if (ids.length === 0) return;
        const now = new Date();
        await this.deps.prisma.user.updateMany({
          where: { id: { in: ids } },
          data: { lastSeenAt: now },
        });
        this.logger.log(
          `presence tick: ${ids.length} synthetic lastSeenAt updated`,
        );
      } catch (err) {
        this.logger.warn(`presence tick failed: ${(err as Error).message}`);
      }
    };
    void tick();
    this.presenceTimer = setInterval(tick, this.presenceTickMs());
  }

  // ─── Polling-pool ──────────────────────────────────────────────────

  /**
   * Для каждого synthetic'а из polling-pool — однократный setTimeout
   * с jitter'ом `[pollingMin, pollingMax]`. По истечении делает
   * joinQueue в случайной категории и переинициализирует таймер.
   * Запускается one-shot последовательностью, чтобы не создать кучу
   * параллельных timer'ов на старте.
   */
  private async startPollingScheduler(): Promise<void> {
    if (!this.deps) return;
    const ids = await this.deps.redis.smembers(ROSTER_IDLE_KEY);
    const pollingIds = ids.filter((id) => isPollingUser(id));
    this.logger.log(
      `polling-pool: ${pollingIds.length} of ${ids.length} synthetic in polling`,
    );
    for (const id of pollingIds) {
      this.scheduleNextPoll(id);
    }
  }

  private scheduleNextPoll(userId: string): void {
    if (this.stopped) return;
    const min = this.pollingMinMs();
    const max = this.pollingMaxMs();
    const delay = min + Math.floor(Math.random() * Math.max(1, max - min));
    const t = setTimeout(() => {
      void this.runPoll(userId).finally(() => this.scheduleNextPoll(userId));
    }, delay);
    // unref не делаем — Nest сам остановит через onModuleDestroy.
    this.pollingTimers.set(userId, t);
  }

  /** Один poll-tick одного synthetic'а: попытка joinQueue в случайной категории. */
  private async runPoll(userId: string): Promise<void> {
    if (this.stopped || !this.deps || !this.matchmaking) return;
    try {
      const state = await this.getState(userId);
      if (state !== 'idle') return; // уже в очереди / в игре

      const cats: LiveQueueCategory[] = ['bullet', 'blitz', 'rapid', 'classical'];
      const cat = cats[Math.floor(Math.random() * cats.length)];
      await this.enqueueSynthetic(userId, cat, 'polling');
    } catch (err) {
      this.logger.warn(`poll for ${userId.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────

  async getState(userId: string): Promise<SyntheticState> {
    if (!this.deps) return 'idle';
    const raw = await this.deps.redis.get(stateKey(userId));
    return raw === 'in_queue' || raw === 'in_game' ? raw : 'idle';
  }

  async setState(userId: string, state: SyntheticState): Promise<void> {
    if (!this.deps) return;
    if (state === 'idle') {
      await this.deps.redis.del(stateKey(userId));
    } else {
      await this.deps.redis.set(stateKey(userId), state, 'EX', 86_400);
    }
  }

  /**
   * Кладёт synthetic'а в очередь категории. Идемпотентно: повторный
   * вызов на in_queue — no-op. Проставляет state и regista'ит userId
   * в `synthetic:in_queue:<cat>` (для подсчёта `currentLiveCount`).
   */
  async enqueueSynthetic(
    userId: string,
    cat: LiveQueueCategory,
    source: 'scheduler' | 'polling',
  ): Promise<boolean> {
    if (!this.deps || !this.matchmaking) return false;
    const state = await this.getState(userId);
    if (state !== 'idle') return false;

    const tc = CANONICAL_TIME_CONTROL[cat];
    try {
      await this.matchmaking.joinQueue(userId, tc.initial, tc.increment);
      await this.deps.redis.sadd(syntheticInQueueKey(cat), userId);
      await this.setState(userId, 'in_queue');
      this.logger.log(
        `enqueueSynthetic: ${userId.slice(0, 8)} → ${cat} (source=${source})`,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `enqueueSynthetic failed for ${userId.slice(0, 8)} cat=${cat}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Снимает synthetic'а с очереди (kill-switch / реверс scheduler'ом). */
  async dequeueSynthetic(
    userId: string,
    cat: LiveQueueCategory,
  ): Promise<boolean> {
    if (!this.deps || !this.matchmaking) return false;
    try {
      await this.matchmaking.leaveQueue(userId, cat);
      await this.deps.redis.srem(syntheticInQueueKey(cat), userId);
      await this.setState(userId, 'idle');
      return true;
    } catch (err) {
      this.logger.warn(
        `dequeueSynthetic failed for ${userId.slice(0, 8)} cat=${cat}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * При завершении партии synthetic возвращается в idle. Вызывается
   * GameService'ом (KS-2161+) или временно — самим scheduler'ом, если
   * замечает запись со state=in_game без активной партии.
   */
  async onGameFinished(userId: string): Promise<void> {
    await this.setState(userId, 'idle');
  }

  /**
   * Сэмпл synthetic'ов из idle-pool, исключая polling-bucket — это
   * «scheduler-pool» (60% от всего). Используется
   * `SyntheticSchedulerService` для пополнения очереди до desired.
   */
  async sampleIdleSchedulerPool(limit: number): Promise<string[]> {
    if (!this.deps) return [];
    const all = await this.deps.redis.smembers(ROSTER_IDLE_KEY);
    const eligible: string[] = [];
    for (const id of all) {
      if (isPollingUser(id)) continue; // оставляем за polling
      const state = await this.getState(id);
      if (state === 'idle') eligible.push(id);
      if (eligible.length >= limit) break;
    }
    return eligible;
  }

  /**
   * Список synthetic'ов в очереди указанной категории (для dequeue
   * сверху при адаптации/kill-switch).
   */
  async listInQueue(cat: LiveQueueCategory): Promise<string[]> {
    if (!this.deps) return [];
    return this.deps.redis.smembers(syntheticInQueueKey(cat));
  }
}
