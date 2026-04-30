import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import {
  INTERNAL_AUTH_HEADER,
  type SyntheticUserListItem,
} from '@kingside/shared';
import { shardOf } from './hash';
import { resolveTaskId } from './ecs-metadata';
import type { BotInstance, BotInstanceState } from './bot-instance';
import { BotInstanceStub } from './bot-instance';

/* ---------------- Redis-абстракция ---------------- */

export interface ManagerRedis {
  set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  scan(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string, string[]]>;
  quit?(): Promise<unknown>;
}

export const BOT_MANAGER_REDIS = Symbol.for('BOT_MANAGER_REDIS');

/* ---------------- HTTP-абстракция ---------------- */

export type ManagerFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export const BOT_MANAGER_HTTP = Symbol.for('BOT_MANAGER_HTTP');

/* ---------------- Константы ---------------- */

/** TTL Redis-локов и heartbeat'а task'а (сек). ADR-034-v2 §3.3. */
export const LOCK_TTL_SEC = 30;
/** Период обновления heartbeat'а и lock-refresh (сек). */
export const HEARTBEAT_INTERVAL_SEC = 10;
/** Бюджет graceful shutdown (мс). ADR §5.4 — 90 сек на партии in_game. */
export const SHUTDOWN_TIMEOUT_MS = 90_000;

const KEY_LOCK_PREFIX = 'synth:active:';
const taskKeyActive = (taskId: string): string => `synth:task:${taskId}:active`;
const taskKeyState = (taskId: string): string => `synth:task:${taskId}:state`;

/* ---------------- BotManager ---------------- */

/**
 * Orchestrator одного ECS-task'а. Знает свой `TASK_ID`, шардирует пул
 * synthetic-аккаунтов, держит Redis-locks, управляет lifecycle
 * `BotInstance`'ов.
 *
 * Конкретный спавн/деспавн партий — в B3v2 (`BotInstance`); B5v2
 * (`Scheduler`) принимает решение, какому боту куда идти. Здесь —
 * только инфраструктура.
 */
@Injectable()
export class BotManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotManager.name);

  /** Идентификатор task'а ECS. Резолвится в onModuleInit. */
  private taskId = '';
  /** Кол-во шардов (default 1). */
  private taskShardCount = 1;
  /** Шард, обслуживаемый этим task'ом. */
  private taskShard = 0;

  /** Список ботов, относящихся к моему шарду. */
  private myBots: SyntheticUserListItem[] = [];

  /** in-memory map активных BotInstance'ов. */
  private readonly instances = new Map<string, BotInstance>();
  /** Локально-известные взятые локи (для refresh / cleanup). */
  private readonly heldLocks = new Set<string>();

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  private readonly redis: ManagerRedis;
  private readonly ownsRedis: boolean;
  private readonly http: ManagerFetchLike;

  private readonly apiUrl: string;
  private readonly internalKey: string;

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(BOT_MANAGER_REDIS) injectedRedis?: ManagerRedis,
    @Optional() @Inject(BOT_MANAGER_HTTP) injectedHttp?: ManagerFetchLike,
  ) {
    this.apiUrl = config.get<string>('API_INTERNAL_URL', '');
    this.internalKey = config.get<string>('SYNTHETIC_BOT_INTERNAL_KEY', '');
    if (injectedRedis) {
      this.redis = injectedRedis;
      this.ownsRedis = false;
    } else {
      const opts: RedisOptions = {
        host: config.get<string>('REDIS_HOST', 'localhost'),
        port: parseInt(String(config.get('REDIS_PORT', 6379)), 10),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      };
      this.redis = new Redis(opts) as unknown as ManagerRedis;
      this.ownsRedis = true;
    }
    this.http = injectedHttp ?? (defaultFetch as ManagerFetchLike);
  }

  /* ===================== Init ===================== */

  async onModuleInit(): Promise<void> {
    this.taskId = await resolveTaskId();
    this.taskShardCount = parseInt(
      String(this.config.get('TASK_SHARD_COUNT', 1)),
      10,
    );
    if (Number.isNaN(this.taskShardCount) || this.taskShardCount < 1) {
      this.logger.warn(
        `TASK_SHARD_COUNT invalid (${this.taskShardCount}), forcing 1`,
      );
      this.taskShardCount = 1;
    }
    this.taskShard = shardOf(this.taskId, this.taskShardCount);

    this.logger.log(
      `BotManager init taskId=${this.taskId} shard=${this.taskShard}/${this.taskShardCount}`,
    );

    try {
      const all = await this.fetchSyntheticUsers();
      this.myBots = all.filter(
        (b) => shardOf(b.id, this.taskShardCount) === this.taskShard,
      );
      this.logger.log(
        `Loaded ${all.length} synthetic users; my shard owns ${this.myBots.length}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to load synthetic users: ${(err as Error).message}. Continue with empty pool.`,
      );
      this.myBots = [];
    }

    await this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.tick().catch((err) =>
        this.logger.error(`heartbeat tick failed: ${(err as Error).message}`),
      );
    }, HEARTBEAT_INTERVAL_SEC * 1000);
    // Не держим event-loop ради таймера — graceful shutdown очистит.
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  /* ===================== Геттеры (для тестов / B3v2 / B5v2) ===================== */

  getTaskId(): string {
    return this.taskId;
  }
  getTaskShard(): number {
    return this.taskShard;
  }
  getTaskShardCount(): number {
    return this.taskShardCount;
  }
  getMyBots(): readonly SyntheticUserListItem[] {
    return this.myBots;
  }
  getHeldLocks(): ReadonlySet<string> {
    return this.heldLocks;
  }
  getInstances(): ReadonlyMap<string, BotInstance> {
    return this.instances;
  }

  /* ===================== Lock API ===================== */

  /**
   * Атомарно берёт лок `synth:active:<botId>` со значением `<taskId>`,
   * TTL 30 сек. Возвращает `false`, если кто-то другой уже держит.
   *
   * Контракт ADR §3.3: `SET ... NX EX ttl` (Redis-нативный SETNX+EX).
   */
  async canStart(botId: string): Promise<boolean> {
    const key = lockKey(botId);
    const result = await this.redis.set(
      key,
      this.taskId,
      'NX',
      'EX',
      LOCK_TTL_SEC,
    );
    if (result === 'OK') {
      this.heldLocks.add(botId);
      return true;
    }
    return false;
  }

  /**
   * Освобождает лок. Удаляет ключ, только если он принадлежит нам
   * (значение === `taskId`) — иначе мы могли бы случайно убить лок
   * следующего владельца, если наш TTL истёк раньше DEL'а.
   */
  async releaseLock(botId: string): Promise<void> {
    const key = lockKey(botId);
    const owner = await this.redis.get(key);
    if (owner === this.taskId) {
      await this.redis.del(key);
    }
    this.heldLocks.delete(botId);
  }

  /**
   * Прокручивает TTL по всем удерживаемым локам. Перед EXPIRE проверяем
   * owner'а: если за пределами нашего TTL ключом завладел кто-то другой —
   * выкидываем из локального набора. Защищает от ситуации, когда наш
   * heartbeat-цикл зависал > 30 сек, ключ истёк, кто-то перезахватил, мы
   * тем временем «обновляем чужой».
   */
  async refreshLocks(): Promise<void> {
    if (this.heldLocks.size === 0) return;
    const lost: string[] = [];
    for (const botId of this.heldLocks) {
      const key = lockKey(botId);
      const owner = await this.redis.get(key);
      if (owner !== this.taskId) {
        lost.push(botId);
        continue;
      }
      await this.redis.expire(key, LOCK_TTL_SEC);
    }
    for (const botId of lost) {
      this.logger.warn(
        `refreshLocks: lock for botId=${botId} no longer owned by ${this.taskId} — dropping`,
      );
      this.heldLocks.delete(botId);
    }
  }

  /* ===================== Spawn / Despawn (заглушки под B3v2) ===================== */

  /**
   * Заглушка спавна `BotInstance`. В B3v2 здесь будет создание реального
   * подключения к game-service по WS. Сейчас — проверка лока + лог.
   */
  async spawn(
    botId: string,
    category: string,
    timeControl: string,
  ): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn(`spawn refused: shutting down (botId=${botId})`);
      return;
    }
    if (!(await this.canStart(botId))) {
      this.logger.log(
        `spawn skipped: lock taken by another task (botId=${botId})`,
      );
      return;
    }
    this.logger.log(
      `would spawn botId=${botId} category=${category} tc=${timeControl}`,
    );
    this.instances.set(botId, new BotInstanceStub(botId, 'idle'));
  }

  /** Заглушка деспавна: shutdown инстанса, releaseLock, удаление из map. */
  async despawn(botId: string): Promise<void> {
    const inst = this.instances.get(botId);
    if (inst) {
      try {
        await inst.shutdown();
      } catch (err) {
        this.logger.warn(
          `despawn: instance.shutdown failed botId=${botId}: ${(err as Error).message}`,
        );
      }
      this.instances.delete(botId);
    }
    await this.releaseLock(botId);
  }

  /**
   * Принудительная регистрация инстанса — для unit-тестов и для B3v2,
   * который инжектит свои инстансы в Manager.
   */
  registerInstance(instance: BotInstance): void {
    this.instances.set(instance.userId, instance);
    this.heldLocks.add(instance.userId);
  }

  /* ===================== Heartbeat ===================== */

  /** Один tick таймера heartbeat'а. */
  async tick(): Promise<void> {
    if (this.isShuttingDown) return;
    await Promise.allSettled([this.writeHeartbeat(), this.refreshLocks()]);
  }

  /**
   * Пишет `synth:task:<taskId>:active = <count>` с TTL 30 сек. count —
   * число активных инстансов (используется по ADR §10.4 для метрик).
   */
  async writeHeartbeat(): Promise<void> {
    await this.redis.set(
      taskKeyActive(this.taskId),
      String(this.instances.size),
      'EX',
      LOCK_TTL_SEC,
    );
  }

  /* ===================== Graceful shutdown ===================== */

  async onModuleDestroy(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.log(
      `Shutting down BotManager taskId=${this.taskId} instances=${this.instances.size}`,
    );

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 1. Объявляем drain'ing для остального кластера / мониторинга.
    try {
      await this.redis.set(
        taskKeyState(this.taskId),
        'draining',
        'EX',
        Math.ceil(SHUTDOWN_TIMEOUT_MS / 1000) + 30,
      );
      this.logger.log(`State -> draining`);
    } catch (err) {
      this.logger.warn(
        `Could not set draining state: ${(err as Error).message}`,
      );
    }

    // 2. Сообщаем всем инстансам shutdown(). in_queue выйдут мгновенно;
    //    in_game корректно дождутся завершения партии (B3v2 решает).
    //    Общий timeout — SHUTDOWN_TIMEOUT_MS.
    await this.shutdownInstances();

    // 3. Чистим Redis-ключи: все наши active-локи, два task-ключа.
    await this.cleanupKeys();

    // 4. Закрываем собственный Redis-клиент (если мы его создавали).
    if (this.ownsRedis && this.redis.quit) {
      try {
        await this.redis.quit();
      } catch (err) {
        this.logger.warn(`Redis quit failed: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Shutdown complete taskId=${this.taskId}`);
  }

  private async shutdownInstances(): Promise<void> {
    const list = Array.from(this.instances.values());
    if (list.length === 0) return;

    // Сначала — все, кто в очереди (быстрый LEAVE).
    const inQueue = list.filter((i) => i.state === 'in_queue');
    const inGame = list.filter((i) => i.state === 'in_game');
    const idle = list.filter((i) => i.state === 'idle');

    this.logger.log(
      `Draining instances: idle=${idle.length} in_queue=${inQueue.length} in_game=${inGame.length}`,
    );

    await Promise.allSettled(
      [...idle, ...inQueue].map((i) =>
        i.shutdown().catch((err) =>
          this.logger.warn(
            `instance.shutdown failed userId=${i.userId}: ${(err as Error).message}`,
          ),
        ),
      ),
    );

    if (inGame.length > 0) {
      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      await Promise.race([
        Promise.allSettled(
          inGame.map((i) =>
            i.shutdown().catch((err) =>
              this.logger.warn(
                `in_game shutdown failed userId=${i.userId}: ${(err as Error).message}`,
              ),
            ),
          ),
        ),
        new Promise<void>((resolve) =>
          setTimeout(
            () => resolve(),
            Math.max(1, deadline - Date.now()),
          ),
        ),
      ]);

      // Проверяем «не успели» — логируем для observability.
      const stillInGame = inGame.filter(
        (i) => (i.state as BotInstanceState) === 'in_game',
      );
      if (stillInGame.length > 0) {
        this.logger.warn(
          `${stillInGame.length} instances still in_game after ${SHUTDOWN_TIMEOUT_MS}ms — would force-resign in B3v2`,
        );
      }
    }

    this.instances.clear();
  }

  private async cleanupKeys(): Promise<void> {
    // 3a. SCAN всех synth:active:* и DEL только тех, чей owner === taskId.
    let cursor = '0';
    let scanned = 0;
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${KEY_LOCK_PREFIX}*`,
        'COUNT',
        500,
      );
      cursor = next;
      scanned += keys.length;
      if (keys.length > 0) {
        // Получаем owner'ов параллельно, удаляем — последовательно
        // (Redis-стороной транзакции нет, но порядок не важен).
        const owners = await Promise.all(
          keys.map((k) => this.redis.get(k)),
        );
        const myKeys = keys.filter((_k, i) => owners[i] === this.taskId);
        if (myKeys.length > 0) {
          removed += await this.redis.del(...myKeys);
        }
      }
    } while (cursor !== '0');

    // 3b. Удаляем task-ключи: heartbeat и state.
    const taskKeys = [taskKeyActive(this.taskId), taskKeyState(this.taskId)];
    await this.redis.del(...taskKeys);
    this.heldLocks.clear();

    this.logger.log(
      `Cleanup complete: scanned=${scanned} removed=${removed} taskKeys=${taskKeys.length}`,
    );
  }

  /* ===================== HTTP к /internal/synthetic-users ===================== */

  private async fetchSyntheticUsers(): Promise<SyntheticUserListItem[]> {
    if (!this.apiUrl) {
      this.logger.warn('API_INTERNAL_URL is empty — skipping users fetch');
      return [];
    }
    const url = `${this.apiUrl.replace(/\/$/, '')}/api/internal/synthetic-users`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.http(url, {
        method: 'GET',
        headers: {
          [INTERNAL_AUTH_HEADER]: this.internalKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await safeText(response);
        throw new Error(`api ${response.status}: ${detail}`);
      }
      const data = (await response.json()) as SyntheticUserListItem[];
      if (!Array.isArray(data)) {
        throw new Error('api returned non-array payload');
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ===================== helpers ===================== */

function lockKey(botId: string): string {
  return `${KEY_LOCK_PREFIX}${botId}`;
}

async function safeText(response: {
  text(): Promise<string>;
}): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable>';
  }
}

const defaultFetch: ManagerFetchLike = (input, init) =>
  globalThis.fetch(input, init) as unknown as ReturnType<ManagerFetchLike>;
