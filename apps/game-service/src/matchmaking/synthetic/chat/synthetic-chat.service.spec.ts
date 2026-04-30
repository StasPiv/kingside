/**
 * KS-2168. Тесты SyntheticChatService — cooldown / cap / триггеры /
 * spontaneous / language.
 */
import {
  SyntheticChatService,
  type SyntheticChatDeps,
  type SyntheticContext,
} from './synthetic-chat.service';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK' as const;
    }),
    incr: jest.fn(async (k: string) => {
      const cur = Number.parseInt(store.get(k) ?? '0', 10);
      const next = cur + 1;
      store.set(k, String(next));
      return next;
    }),
    expire: jest.fn(async () => 1),
  };
}

function makeChat() {
  const sent: Array<{ gameId: string; userId: string; content: string }> = [];
  return {
    _sent: sent,
    sendMessage: jest.fn(async (gameId: string, userId: string, content: string) => {
      sent.push({ gameId, userId, content });
      return null;
    }),
  };
}

class FakeTimers {
  pending: Array<() => void> = [];
  setTimeout = (cb: () => void, _ms: number): unknown => {
    this.pending.push(cb);
    return cb;
  };
  fireAll(): void {
    const list = [...this.pending];
    this.pending = [];
    for (const cb of list) cb();
  }
}

const ctx: SyntheticContext = {
  syntheticUserId: 'synth-1',
  syntheticCountry: 'US',
  gameId: 'game-1',
};

describe('SyntheticChatService — KS-2168', () => {
  beforeEach(() => {
    process.env.SYNTHETIC_CHAT_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.SYNTHETIC_CHAT_ENABLED;
  });

  function setup(opts: { random?: () => number } = {}) {
    const redis = makeRedis();
    const chat = makeChat();
    const timers = new FakeTimers();
    const svc = new SyntheticChatService();
    const deps: SyntheticChatDeps = {
      chat,
      redis,
      setTimeoutFn: timers.setTimeout,
      random: opts.random,
    };
    svc.configure(deps);
    return { svc, redis, chat, timers };
  }

  it('feature flag off → "disabled" без send', async () => {
    delete process.env.SYNTHETIC_CHAT_ENABLED;
    const s = setup();
    const r = await s.svc.onUserMessage(ctx, 'hi');
    expect(r).toBe('disabled');
    expect(s.chat._sent).toHaveLength(0);
  });

  it('"hi" → ответ из greetings pool в EN (country=US)', async () => {
    const s = setup({ random: () => 0 });
    const r = await s.svc.onUserMessage(ctx, 'hi');
    expect(r).toBe('sent');
    s.timers.fireAll();
    await flushPromises();
    expect(s.chat._sent).toHaveLength(1);
    expect(['hi', 'hello', 'hey there']).toContain(s.chat._sent[0].content);
  });

  it('country=RU + кириллический текст → ru-pool', async () => {
    const s = setup({ random: () => 0 });
    await s.svc.onUserMessage(
      { ...ctx, syntheticCountry: 'RU' },
      'привет!',
    );
    s.timers.fireAll();
    await flushPromises();
    expect(s.chat._sent[0].content).toBe('привет');
  });

  it('нераспознанный текст → "no-trigger", чат не двигается', async () => {
    const s = setup();
    const r = await s.svc.onUserMessage(ctx, 'what is your favourite opening?');
    expect(r).toBe('no-trigger');
    s.timers.fireAll();
    expect(s.chat._sent).toHaveLength(0);
  });

  it('cooldown: второй "hi" сразу после первого → "cooldown"', async () => {
    const s = setup();
    expect(await s.svc.onUserMessage(ctx, 'hi')).toBe('sent');
    expect(await s.svc.onUserMessage(ctx, 'hi')).toBe('cooldown');
    s.timers.fireAll();
    await flushPromises();
    // Только один send.
    expect(s.chat._sent).toHaveLength(1);
  });

  it('cap: после 5 сообщений 6-й триггер → "cap"', async () => {
    const s = setup();
    // Принудительно зафиксируем «уже было 5».
    s.redis._store.set(`synth:chat:count:${ctx.gameId}:${ctx.syntheticUserId}`, '5');
    const r = await s.svc.onUserMessage(ctx, 'hi');
    expect(r).toBe('cap');
    s.timers.fireAll();
    expect(s.chat._sent).toHaveLength(0);
  });

  it('"oops" в активной партии → triggers; после конца → "no-trigger"', async () => {
    const s1 = setup();
    expect(await s1.svc.onUserMessage(ctx, 'oops', false)).toBe('sent');

    const s2 = setup();
    expect(await s2.svc.onUserMessage(ctx, 'oops', true)).toBe('no-trigger');
  });

  it('onGameStarted: random < 0.10 → отправляется приветствие', async () => {
    const s = setup({ random: () => 0.05 });
    const r = await s.svc.onGameStarted(ctx);
    expect(r).toBe('sent');
    s.timers.fireAll();
    await flushPromises();
    expect(s.chat._sent).toHaveLength(1);
  });

  it('onGameStarted: random >= 0.10 → пропуск', async () => {
    const s = setup({ random: () => 0.5 });
    const r = await s.svc.onGameStarted(ctx);
    expect(r).toBe('skipped');
  });

  it('onGameFinished: random < 0.50 → отправка closing', async () => {
    const s = setup({ random: () => 0.2 });
    const r = await s.svc.onGameFinished(ctx);
    expect(r).toBe('sent');
    s.timers.fireAll();
    await flushPromises();
    expect(['gg', 'wp', 'thx']).toContain(s.chat._sent[0].content);
  });

  it('onGameFinished: random >= 0.50 → пропуск', async () => {
    const s = setup({ random: () => 0.7 });
    expect(await s.svc.onGameFinished(ctx)).toBe('skipped');
  });

  it('cooldown ключ ставится с EX=60', async () => {
    const s = setup();
    await s.svc.onUserMessage(ctx, 'hi');
    expect(s.redis.set).toHaveBeenCalledWith(
      `synth:chat:cooldown:${ctx.gameId}:${ctx.syntheticUserId}`,
      '1',
      'EX',
      60,
    );
  });

  it('cap-счётчик инкрементится и получает TTL на первом инкременте', async () => {
    const s = setup();
    await s.svc.onUserMessage(ctx, 'hi');
    expect(s.redis.incr).toHaveBeenCalledWith(
      `synth:chat:count:${ctx.gameId}:${ctx.syntheticUserId}`,
    );
    expect(s.redis.expire).toHaveBeenCalledWith(
      `synth:chat:count:${ctx.gameId}:${ctx.syntheticUserId}`,
      24 * 60 * 60,
    );
  });
});

function flushPromises(): Promise<void> {
  return new Promise((res) => setImmediate(res));
}
