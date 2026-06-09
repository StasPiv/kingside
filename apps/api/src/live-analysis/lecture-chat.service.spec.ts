/**
 * KS-4008 / ADR-121 Phase 1. Unit-тесты на чат-сервис:
 *   - normalizeText: trim, длина, control-char, emoji-codepoints.
 *   - checkAndConsumeRateLimit: 3 проходят, 4-я отказывается, окно
 *     скользит (после WINDOW_MS снова можно).
 *   - checkAndConsumeDuplicate: одинаковый текст подряд — отказ,
 *     разный — проходит.
 *   - isMuted / muteUser идемпотентность.
 *
 * Redis мокается in-memory (jest.Mock'и для нужных команд). Prisma —
 * жёсткие моки на findUnique/upsert/create/findMany/findFirst/update.
 */
import { LectureChatService, ChatValidationError } from './lecture-chat.service';
import { LECTURE_CHAT_LIMITS } from '@kingside/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

// ─── Redis stub: in-memory sorted set + KV ──────────────────────────

class StubRedis {
  private zsets = new Map<string, Array<{ score: number; member: string }>>();
  private kv = new Map<string, { value: string; expiresAt: number | null }>();

  zremrangebyscore(key: string, min: number, max: number): number {
    const arr = this.zsets.get(key) ?? [];
    const filtered = arr.filter((e) => e.score < min || e.score > max);
    this.zsets.set(key, filtered);
    return arr.length - filtered.length;
  }
  zcard(key: string): number {
    return (this.zsets.get(key) ?? []).length;
  }
  zadd(key: string, score: number, member: string): number {
    const arr = this.zsets.get(key) ?? [];
    arr.push({ score, member });
    this.zsets.set(key, arr);
    return 1;
  }
  expire(_k: string, _s: number): number {
    return 1;
  }
  pipeline(): {
    zremrangebyscore: (k: string, mn: number, mx: number) => unknown;
    zcard: (k: string) => unknown;
    exec: () => Promise<Array<[null, unknown]>>;
  } {
    const queue: Array<() => unknown> = [];
    return {
      zremrangebyscore: (k, mn, mx) => {
        queue.push(() => this.zremrangebyscore(k, mn, mx));
        return null;
      },
      zcard: (k) => {
        queue.push(() => this.zcard(k));
        return null;
      },
      exec: async () => queue.map((fn) => [null, fn()] as [null, unknown]),
    };
  }
  multi(): {
    zadd: (k: string, s: number, m: string) => any;
    expire: (k: string, s: number) => any;
    exec: () => Promise<unknown[]>;
  } {
    const queue: Array<() => unknown> = [];
    const chain: any = {
      zadd: (k: string, s: number, m: string): any => {
        queue.push(() => this.zadd(k, s, m));
        return chain;
      },
      expire: (k: string, s: number): any => {
        queue.push(() => this.expire(k, s));
        return chain;
      },
      exec: async (): Promise<unknown[]> => queue.map((fn) => fn()),
    };
    return chain;
  }
  async get(key: string): Promise<string | null> {
    const v = this.kv.get(key);
    if (!v) return null;
    if (v.expiresAt && v.expiresAt < Date.now()) {
      this.kv.delete(key);
      return null;
    }
    return v.value;
  }
  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    let ttlMs: number | null = null;
    // Поддерживаем форму SET key value EX <sec>.
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      ttlMs = (args[1] as number) * 1000;
    }
    this.kv.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
    return 'OK';
  }
}

function makeService(prismaMock: Partial<PrismaService> = {}): {
  svc: LectureChatService;
  redis: StubRedis;
} {
  const redis = new StubRedis();
  const svc = new LectureChatService(
    prismaMock as PrismaService,
    redis as unknown as RedisService,
  );
  return { svc, redis };
}

// ─── normalizeText ───────────────────────────────────────────────────

describe('LectureChatService.normalizeText (KS-4008)', () => {
  const { svc } = makeService();

  it('trim + не пустой → возвращает обрезанный', () => {
    expect(svc.normalizeText('  hello  ')).toBe('hello');
  });

  it('пустая строка → too_short', () => {
    expect(() => svc.normalizeText('   ')).toThrow(ChatValidationError);
    try {
      svc.normalizeText('');
    } catch (e) {
      expect((e as ChatValidationError).code).toBe('too_short');
    }
  });

  it('длина > MAX_TEXT_LENGTH → too_long', () => {
    const text = 'a'.repeat(LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH + 1);
    try {
      svc.normalizeText(text);
      fail('expected throw');
    } catch (e) {
      expect((e as ChatValidationError).code).toBe('too_long');
    }
  });

  it('control-char (BEL 0x07) → control_char', () => {
    try {
      svc.normalizeText('helloworld');
      fail('expected throw');
    } catch (e) {
      expect((e as ChatValidationError).code).toBe('control_char');
    }
  });

  it('newline и tab разрешены', () => {
    expect(svc.normalizeText('line1\nline2\there')).toBe('line1\nline2\there');
  });

  it('emoji считается 1 codepoint, не 2 (учёт суррогатных пар)', () => {
    // 500 эмодзи → ровно лимит, проходит.
    const ok = '🙂'.repeat(LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH);
    expect(() => svc.normalizeText(ok)).not.toThrow();
    // 501 → too_long.
    const bad = '🙂'.repeat(LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH + 1);
    try {
      svc.normalizeText(bad);
      fail('expected throw');
    } catch (e) {
      expect((e as ChatValidationError).code).toBe('too_long');
    }
  });
});

// ─── rate-limit ──────────────────────────────────────────────────────

describe('LectureChatService.checkAndConsumeRateLimit (KS-4008)', () => {
  const LECTURE = 'L1';
  const USER = 'U1';

  it('первые 3 — проходят, 4-я отказывается', async () => {
    const { svc } = makeService();
    expect(await svc.checkAndConsumeRateLimit(LECTURE, USER)).toBe(true);
    expect(await svc.checkAndConsumeRateLimit(LECTURE, USER)).toBe(true);
    expect(await svc.checkAndConsumeRateLimit(LECTURE, USER)).toBe(true);
    expect(await svc.checkAndConsumeRateLimit(LECTURE, USER)).toBe(false);
  });

  it('после WINDOW_MS старые точки выпадают — снова можно', async () => {
    const { svc, redis } = makeService();
    // Имитируем 3 сообщения, отправленные «давно».
    const past =
      Date.now() - LECTURE_CHAT_LIMITS.RATE_LIMIT_WINDOW_MS - 5000;
    const key = `chat-rl:${LECTURE}:${USER}`;
    redis.zadd(key, past, 'm1');
    redis.zadd(key, past + 10, 'm2');
    redis.zadd(key, past + 20, 'm3');
    // 4-я сейчас — должна пройти (предыдущие выпали по score).
    expect(await svc.checkAndConsumeRateLimit(LECTURE, USER)).toBe(true);
  });

  it('лимит per-user независимый: U1 заполнил окно — U2 не задет', async () => {
    const { svc } = makeService();
    for (let i = 0; i < LECTURE_CHAT_LIMITS.RATE_LIMIT_WINDOW_COUNT; i++) {
      expect(await svc.checkAndConsumeRateLimit(LECTURE, 'A')).toBe(true);
    }
    expect(await svc.checkAndConsumeRateLimit(LECTURE, 'A')).toBe(false);
    expect(await svc.checkAndConsumeRateLimit(LECTURE, 'B')).toBe(true);
  });
});

// ─── duplicate guard ────────────────────────────────────────────────

describe('LectureChatService.checkAndConsumeDuplicate (KS-4008)', () => {
  const LECTURE = 'L1';
  const USER = 'U1';

  it('подряд два одинаковых — второй отказан', async () => {
    const { svc } = makeService();
    expect(await svc.checkAndConsumeDuplicate(LECTURE, USER, 'hello')).toBe(true);
    expect(await svc.checkAndConsumeDuplicate(LECTURE, USER, 'hello')).toBe(false);
  });

  it('разные тексты — оба проходят', async () => {
    const { svc } = makeService();
    expect(await svc.checkAndConsumeDuplicate(LECTURE, USER, 'a')).toBe(true);
    expect(await svc.checkAndConsumeDuplicate(LECTURE, USER, 'b')).toBe(true);
  });

  it('тот же текст у разных юзеров — оба проходят', async () => {
    const { svc } = makeService();
    expect(await svc.checkAndConsumeDuplicate(LECTURE, 'A', 'hello')).toBe(true);
    expect(await svc.checkAndConsumeDuplicate(LECTURE, 'B', 'hello')).toBe(true);
  });
});

// ─── mute / persist / snapshot — с моком Prisma ────────────────────

describe('LectureChatService Prisma flows (KS-4008)', () => {
  it('isMuted true если запись найдена', async () => {
    const prisma = {
      lectureChatMute: {
        findUnique: jest.fn().mockResolvedValue({ id: 'm-1' }),
      },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    expect(await svc.isMuted('L', 'U')).toBe(true);
  });

  it('isMuted false если null', async () => {
    const prisma = {
      lectureChatMute: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    expect(await svc.isMuted('L', 'U')).toBe(false);
  });

  it('persistMessage ставит isTrainerMessage по authorId===ownerId', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'm-1',
      lectureId: 'L',
      authorId: 'U-trainer',
      text: 'hi',
      createdAt: new Date('2026-06-09T00:00:00Z'),
      isTrainerMessage: true,
      pinned: false,
      deletedAt: null,
      kind: 'user',
    });
    const prisma = {
      lectureChatMessage: { create },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    const r = await svc.persistMessage({
      lectureId: 'L',
      ownerId: 'U-trainer',
      authorId: 'U-trainer',
      authorUsername: 'coach',
      text: 'hi',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isTrainerMessage: true,
          authorId: 'U-trainer',
          text: 'hi',
        }),
      }),
    );
    expect(r.isTrainerMessage).toBe(true);
    expect(r.authorUsername).toBe('coach');
  });

  it('persistMessage ставит isTrainerMessage=false для ученика', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'm-2',
      lectureId: 'L',
      authorId: 'U-stud',
      text: 'q',
      createdAt: new Date(),
      isTrainerMessage: false,
      pinned: false,
      deletedAt: null,
      kind: 'user',
    });
    const prisma = {
      lectureChatMessage: { create },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    const r = await svc.persistMessage({
      lectureId: 'L',
      ownerId: 'U-trainer',
      authorId: 'U-stud',
      authorUsername: 'student',
      text: 'q',
    });
    expect(r.isTrainerMessage).toBe(false);
  });

  it('softDeleteMessage: отказ если запись не найдена / чужая лекция', async () => {
    const prisma = {
      lectureChatMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    expect(
      await svc.softDeleteMessage({
        lectureId: 'L',
        messageId: 'M',
        deletedById: 'T',
      }),
    ).toBe(false);
    expect(
      (prisma as unknown as { lectureChatMessage: { update: jest.Mock } })
        .lectureChatMessage.update,
    ).not.toHaveBeenCalled();
  });

  it('softDeleteMessage: отказ если уже удалено', async () => {
    const update = jest.fn();
    const prisma = {
      lectureChatMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'M',
          lectureId: 'L',
          deletedAt: new Date(),
        }),
        update,
      },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    expect(
      await svc.softDeleteMessage({
        lectureId: 'L',
        messageId: 'M',
        deletedById: 'T',
      }),
    ).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('softDeleteMessage: успех ставит deletedAt + deletedById', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      lectureChatMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'M',
          lectureId: 'L',
          deletedAt: null,
        }),
        update,
      },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    const ok = await svc.softDeleteMessage({
      lectureId: 'L',
      messageId: 'M',
      deletedById: 'T',
    });
    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'M' },
        data: expect.objectContaining({ deletedById: 'T' }),
      }),
    );
  });

  it('muteUser использует upsert по [lectureId,userId]', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      lectureChatMute: { upsert },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    await svc.muteUser({ lectureId: 'L', userId: 'U', mutedById: 'T' });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lectureId_userId: { lectureId: 'L', userId: 'U' } },
        create: expect.objectContaining({ mutedById: 'T' }),
      }),
    );
  });

  it('getSnapshotMessages: deleted → text "[удалено]" но запись в ленте остаётся', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'm-2',
        lectureId: 'L',
        authorId: 'U',
        text: 'original',
        createdAt: new Date('2026-06-09T00:00:01Z'),
        isTrainerMessage: false,
        pinned: false,
        deletedAt: new Date('2026-06-09T00:00:02Z'),
        kind: 'user',
        author: { username: 'u' },
      },
      {
        id: 'm-1',
        lectureId: 'L',
        authorId: 'U',
        text: 'first',
        createdAt: new Date('2026-06-09T00:00:00Z'),
        isTrainerMessage: false,
        pinned: false,
        deletedAt: null,
        kind: 'user',
        author: { username: 'u' },
      },
    ]);
    const prisma = {
      lectureChatMessage: { findMany },
    } as unknown as PrismaService;
    const { svc } = makeService(prisma);
    const rows = await svc.getSnapshotMessages('L');
    // Хронологический порядок: первая запись — старая.
    expect(rows.map((r) => r.id)).toEqual(['m-1', 'm-2']);
    expect(rows[0].text).toBe('first');
    expect(rows[1].text).toBe('[удалено]');
    expect(rows[1].deletedAt).not.toBeNull();
  });
});
