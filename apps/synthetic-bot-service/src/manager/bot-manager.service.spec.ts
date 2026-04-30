import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  BOT_MANAGER_HTTP,
  BOT_MANAGER_REDIS,
  BotManager,
  type ManagerFetchLike,
  type ManagerRedis,
} from './bot-manager.service';
import { BotInstanceStub } from './bot-instance';

/* ==================== Redis fake ==================== */

interface FakeEntry {
  value: string;
  expireAt: number | null;
}

class FakeRedis implements ManagerRedis {
  private store = new Map<string, FakeEntry>();
  public commandLog: string[] = [];

  // ioredis принимает variadic-аргументы; повторяем такую же сигнатуру
  // (NX/XX/EX интерпретируем). Возвращаем 'OK' / null для NX-конфликта.
  async set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<unknown> {
    let nx = false;
    let xx = false;
    let exSeconds: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'NX') nx = true;
      else if (a === 'XX') xx = true;
      else if (a === 'EX') {
        exSeconds = Number(args[i + 1]);
        i++;
      }
    }
    this.evictExpired();
    const exists = this.store.has(key);
    if (nx && exists) return null;
    if (xx && !exists) return null;
    this.store.set(key, {
      value,
      expireAt: exSeconds ? Date.now() + exSeconds * 1000 : null,
    });
    this.commandLog.push(
      `SET ${key} ${value} ${nx ? 'NX ' : ''}${xx ? 'XX ' : ''}${
        exSeconds ? `EX ${exSeconds}` : ''
      }`.trim(),
    );
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.evictExpired();
    return this.store.get(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) {
        n++;
        this.commandLog.push(`DEL ${k}`);
      }
    }
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.evictExpired();
    const e = this.store.get(key);
    if (!e) return 0;
    e.expireAt = Date.now() + seconds * 1000;
    this.commandLog.push(`EXPIRE ${key} ${seconds}`);
    return 1;
  }

  async scan(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string, string[]]> {
    let match = '*';
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'MATCH') {
        match = String(args[i + 1]);
        i++;
      } else if (a === 'COUNT') {
        i++;
      }
    }
    this.evictExpired();
    const re = new RegExp(
      '^' + match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    const keys = Array.from(this.store.keys()).filter((k) => re.test(k));
    return ['0', keys];
  }

  /* helpers для тестов */
  forceExpire(key: string): void {
    const e = this.store.get(key);
    if (e) e.expireAt = Date.now() - 1;
  }
  setRaw(key: string, value: string, ttlSec: number | null = null): void {
    this.store.set(key, {
      value,
      expireAt: ttlSec ? Date.now() + ttlSec * 1000 : null,
    });
  }
  getTTL(key: string): number | null {
    const e = this.store.get(key);
    if (!e || e.expireAt === null) return null;
    return Math.max(0, Math.round((e.expireAt - Date.now()) / 1000));
  }
  size(): number {
    this.evictExpired();
    return this.store.size;
  }
  has(key: string): boolean {
    this.evictExpired();
    return this.store.has(key);
  }
  rawGet(key: string): string | null {
    this.evictExpired();
    return this.store.get(key)?.value ?? null;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expireAt !== null && v.expireAt < now) this.store.delete(k);
    }
  }
}

/* ==================== HTTP fake ==================== */

function httpStub(
  data: unknown,
  status = 200,
): ManagerFetchLike & { calls: number } {
  const fn = ((async () => {
    fn.calls++;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return typeof data === 'string' ? data : JSON.stringify(data);
      },
      async json() {
        return data;
      },
    };
  }) as unknown) as ManagerFetchLike & { calls: number };
  fn.calls = 0;
  return fn;
}

/* ==================== Build helpers ==================== */

interface ManagerCtx {
  manager: BotManager;
  redis: FakeRedis;
  http: ManagerFetchLike & { calls: number };
}

async function buildManager(opts: {
  shardCount?: number;
  bots?: Array<{ id: string; username: string }>;
  taskId?: string;
}): Promise<ManagerCtx> {
  const redis = new FakeRedis();
  const http = httpStub(
    (opts.bots ?? []).map((b) => ({
      id: b.id,
      username: b.username,
      rating: { bullet: 1500, blitz: 1500, rapid: 1500, classical: 1500 },
    })),
  );

  const env = {
    API_INTERNAL_URL: 'http://api.test',
    SYNTHETIC_BOT_INTERNAL_KEY: 'k',
    TASK_SHARD_COUNT: String(opts.shardCount ?? 1),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: false, ignoreEnvFile: true, load: [() => env] }),
    ],
    providers: [
      BotManager,
      { provide: BOT_MANAGER_REDIS, useValue: redis },
      { provide: BOT_MANAGER_HTTP, useValue: http },
    ],
  }).compile();

  const manager = moduleRef.get(BotManager);
  if (opts.taskId) {
    // Прокидываем taskId до onModuleInit (который читает ECS metadata).
    // Делаем это через setter в тестах.
    (manager as unknown as { taskId: string }).taskId = opts.taskId;
  }
  return { manager, redis, http };
}

/* ==================== Tests ==================== */

describe('BotManager — locks', () => {
  let ctx: ManagerCtx;

  beforeEach(async () => {
    ctx = await buildManager({ taskId: 'task-A' });
  });

  it('canStart берёт лок только если ключ свободен', async () => {
    expect(await ctx.manager.canStart('bot-001')).toBe(true);
    expect(ctx.redis.rawGet('synth:active:bot-001')).toBe('task-A');
    // повторный вызов — true (ключ всё ещё наш, SETNX → null, но это OK
    // для уже взятого лока: возвращаем false; верхний слой не должен
    // повторно вызывать canStart на свой же бот).
    expect(await ctx.manager.canStart('bot-001')).toBe(false);
  });

  it('Сценарий 2 (race): другой taskId уже владеет — false', async () => {
    ctx.redis.setRaw('synth:active:bot-001', 'task-B', 30);
    expect(await ctx.manager.canStart('bot-001')).toBe(false);
    expect(ctx.redis.rawGet('synth:active:bot-001')).toBe('task-B');
  });

  it('Сценарий 3 (TTL истёк): чужой лок исчез — мы успешно берём', async () => {
    ctx.redis.setRaw('synth:active:bot-001', 'task-B', 30);
    ctx.redis.forceExpire('synth:active:bot-001');
    expect(await ctx.manager.canStart('bot-001')).toBe(true);
    expect(ctx.redis.rawGet('synth:active:bot-001')).toBe('task-A');
  });

  it('releaseLock удаляет только наш ключ', async () => {
    ctx.redis.setRaw('synth:active:bot-001', 'task-B', 30);
    await ctx.manager.releaseLock('bot-001');
    expect(ctx.redis.rawGet('synth:active:bot-001')).toBe('task-B');
  });

  it('releaseLock удаляет наш собственный ключ', async () => {
    await ctx.manager.canStart('bot-001');
    await ctx.manager.releaseLock('bot-001');
    expect(ctx.redis.has('synth:active:bot-001')).toBe(false);
  });
});

describe('BotManager — refreshLocks', () => {
  it('обновляет TTL только своих ключей', async () => {
    const ctx = await buildManager({ taskId: 'task-A' });
    await ctx.manager.canStart('bot-001');
    await ctx.manager.canStart('bot-002');
    // Подделываем чужой лок в локальном set'е (имитация stale-state).
    ctx.redis.setRaw('synth:active:bot-003', 'task-OTHER', 30);
    (ctx.manager.getHeldLocks() as Set<string>).add('bot-003');

    // Сначала TTL около 30 сек. Сжимаем до 1 сек, потом refresh должен
    // вернуть к 30.
    ctx.redis.setRaw('synth:active:bot-001', 'task-A', 1);
    ctx.redis.setRaw('synth:active:bot-002', 'task-A', 1);

    await ctx.manager.refreshLocks();
    expect(ctx.redis.getTTL('synth:active:bot-001')).toBeGreaterThan(20);
    expect(ctx.redis.getTTL('synth:active:bot-002')).toBeGreaterThan(20);
    // bot-003 — чужой; не трогаем.
    expect(ctx.redis.getTTL('synth:active:bot-003')).toBeLessThanOrEqual(30);
    expect(ctx.manager.getHeldLocks().has('bot-003')).toBe(false);
  });
});

describe('BotManager — initFromUsers (Сценарий 1: шардирование)', () => {
  const cleanups: BotManager[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const m = cleanups.pop();
      if (m) await m.onModuleDestroy();
    }
  });

  it('детерминированно фильтрует свой шард', async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({
      id: `bot-${i.toString().padStart(4, '0')}`,
      username: `bot${i}`,
    }));
    const ctxA = await buildManager({ shardCount: 3, bots: all, taskId: 'task-A' });
    const ctxB = await buildManager({ shardCount: 3, bots: all, taskId: 'task-A' });

    await ctxA.manager.onModuleInit();
    await ctxB.manager.onModuleInit();
    cleanups.push(ctxA.manager, ctxB.manager);

    // Тот же taskId, тот же список — тот же набор.
    const idsA = ctxA.manager.getMyBots().map((b) => b.id);
    const idsB = ctxB.manager.getMyBots().map((b) => b.id);
    expect(idsB).toEqual(idsA);
    // ≈66 ± допустимый разброс.
    expect(idsA.length).toBeGreaterThan(40);
    expect(idsA.length).toBeLessThan(95);

    // Heartbeat-ключ зарегистрирован.
    expect(ctxA.redis.rawGet(`synth:task:${ctxA.manager.getTaskId()}:active`)).toBe(
      String(ctxA.manager.getInstances().size),
    );
  });

  it('два разных taskId дают разные шарды (если они в разных шардах хеша)', async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({
      id: `bot-${i}`,
      username: `bot${i}`,
    }));
    const ctxA = await buildManager({ shardCount: 3, bots: all, taskId: 'task-shard-A' });
    const ctxB = await buildManager({ shardCount: 3, bots: all, taskId: 'task-shard-B' });

    await ctxA.manager.onModuleInit();
    await ctxB.manager.onModuleInit();
    cleanups.push(ctxA.manager, ctxB.manager);

    const setA = new Set(ctxA.manager.getMyBots().map((b) => b.id));
    const setB = new Set(ctxB.manager.getMyBots().map((b) => b.id));
    if (ctxA.manager.getTaskShard() !== ctxB.manager.getTaskShard()) {
      // Шарды не пересекаются.
      for (const id of setA) expect(setB.has(id)).toBe(false);
    }
  });
});

describe('BotManager — graceful shutdown (Сценарий 4)', () => {
  it('устанавливает state=draining, чистит наши ключи, оставляет чужие', async () => {
    const ctx = await buildManager({ taskId: 'task-A' });

    // Поднимаем 5 заглушечных инстансов разных состояний.
    const states = ['idle', 'in_queue', 'in_game', 'in_queue', 'idle'] as const;
    for (let i = 0; i < 5; i++) {
      const inst = new BotInstanceStub(`bot-${i}`, states[i]);
      ctx.manager.registerInstance(inst);
      // регистрируем соответствующий лок в Redis.
      ctx.redis.setRaw(`synth:active:bot-${i}`, 'task-A', 30);
    }
    // Чужой лок — не должен быть тронут.
    ctx.redis.setRaw('synth:active:other-bot', 'task-X', 30);
    // Наш task-key (heartbeat) и state — после shutdown должны исчезнуть.
    ctx.redis.setRaw('synth:task:task-A:active', '5', 30);

    await ctx.manager.onModuleDestroy();

    // 1. State был выставлен в draining (хоть после cleanupKeys мы его и
    //    удаляем — но в commandLog есть SET с draining).
    expect(
      ctx.redis.commandLog.some(
        (c) => c.startsWith('SET synth:task:task-A:state draining'),
      ),
    ).toBe(true);

    // 2. Все наши active-локи удалены.
    for (let i = 0; i < 5; i++) {
      expect(ctx.redis.has(`synth:active:bot-${i}`)).toBe(false);
    }
    // 3. Чужой жив.
    expect(ctx.redis.rawGet('synth:active:other-bot')).toBe('task-X');
    // 4. Task-keys удалены.
    expect(ctx.redis.has('synth:task:task-A:active')).toBe(false);
    expect(ctx.redis.has('synth:task:task-A:state')).toBe(false);
    // 5. Map очищен.
    expect(ctx.manager.getInstances().size).toBe(0);
  });

  it('повторный вызов onModuleDestroy безопасен', async () => {
    const ctx = await buildManager({ taskId: 'task-A' });
    await ctx.manager.onModuleDestroy();
    await expect(ctx.manager.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('BotManager — spawn / despawn (заглушки B3v2)', () => {
  it('spawn: лок свободен → инстанс зарегистрирован, лок взят', async () => {
    const ctx = await buildManager({ taskId: 'task-A' });
    await ctx.manager.spawn('bot-1', 'blitz', '5+0');
    expect(ctx.manager.getInstances().has('bot-1')).toBe(true);
    expect(ctx.redis.rawGet('synth:active:bot-1')).toBe('task-A');
  });

  it('spawn: лок чужой → пропуск без падения', async () => {
    const ctx = await buildManager({ taskId: 'task-A' });
    ctx.redis.setRaw('synth:active:bot-1', 'task-OTHER', 30);
    await ctx.manager.spawn('bot-1', 'blitz', '5+0');
    expect(ctx.manager.getInstances().has('bot-1')).toBe(false);
    expect(ctx.redis.rawGet('synth:active:bot-1')).toBe('task-OTHER');
  });

  it('despawn: shutdown инстанса + releaseLock', async () => {
    const ctx = await buildManager({ taskId: 'task-A' });
    await ctx.manager.spawn('bot-1', 'blitz', '5+0');
    await ctx.manager.despawn('bot-1');
    expect(ctx.manager.getInstances().has('bot-1')).toBe(false);
    expect(ctx.redis.has('synth:active:bot-1')).toBe(false);
  });
});
