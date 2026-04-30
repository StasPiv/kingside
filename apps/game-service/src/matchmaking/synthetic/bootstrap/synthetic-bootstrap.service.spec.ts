/**
 * KS-2163. Тесты SyntheticBootstrapService — tickOnce поведение,
 * idempotent restart через DB-counts, лимит параллелизма.
 */
import {
  SyntheticBootstrapService,
  type BootstrapGameLauncher,
  type BootstrapPrisma,
} from './synthetic-bootstrap.service';

interface FakeUser {
  id: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
}

interface FakeGame {
  whiteId: string;
  blackId: string;
}

function makePrisma(opts: {
  users: FakeUser[];
  games?: FakeGame[];
}) {
  const games = opts.games ?? [];
  return {
    user: {
      findMany: jest.fn(async () => opts.users),
    },
    $queryRawUnsafe: jest.fn(async (_query: string, ids: string[]) => {
      // Considered synthetic-vs-synthetic only.
      const counts = new Map<string, number>();
      for (const g of games) {
        if (!ids.includes(g.whiteId) || !ids.includes(g.blackId)) continue;
        const a = g.whiteId < g.blackId ? g.whiteId : g.blackId;
        const b = g.whiteId < g.blackId ? g.blackId : g.whiteId;
        const k = `${a}|${b}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.entries()].map(([k, c]) => {
        const [a, b] = k.split('|');
        return { a, b, cnt: c };
      });
    }),
  } as unknown as BootstrapPrisma;
}

function makeLauncher(): BootstrapGameLauncher & {
  _starts: Array<{ whiteId: string; blackId: string; category: string }>;
} {
  const starts: Array<{ whiteId: string; blackId: string; category: string }> = [];
  let seq = 0;
  const launcher = {
    _starts: starts,
    start: jest.fn(async (opts: { whiteId: string; blackId: string; category: string }) => {
      starts.push(opts);
      return { gameId: `g-${++seq}` };
    }),
  };
  return launcher;
}

function makeUsers(n: number, baseRating = 1500): FakeUser[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    ratingBullet: baseRating,
    ratingBlitz: baseRating,
    ratingRapid: baseRating,
    ratingClassical: baseRating,
  }));
}

describe('SyntheticBootstrapService.tickOnce — KS-2163', () => {
  beforeEach(() => {
    delete process.env.SYNTHETIC_BOOTSTRAP_ENABLED;
    delete process.env.SYNTHETIC_BOOTSTRAP_PARALLELISM;
    process.env[require('@kingside/shared').SyntheticEnvKey.BootstrapTargetGames] = '5';
  });

  afterEach(() => {
    delete process.env[require('@kingside/shared').SyntheticEnvKey.BootstrapTargetGames];
  });

  it('пустая БД → progress.done=false, totalSynthetics=0, partition не запускается', async () => {
    const prisma = makePrisma({ users: [] });
    const launcher = makeLauncher();
    const svc = new SyntheticBootstrapService();
    svc.configure(prisma, launcher);
    const r = await svc.tickOnce();
    expect(r.pairsLaunched).toBe(0);
    expect(r.progress.totalSynthetics).toBe(0);
    expect(launcher._starts).toHaveLength(0);
  });

  it('20 synthetic users, 0 games, parallel=3 → запускается 3 пары', async () => {
    process.env.SYNTHETIC_BOOTSTRAP_PARALLELISM = '3';
    const prisma = makePrisma({ users: makeUsers(20) });
    const launcher = makeLauncher();
    const svc = new SyntheticBootstrapService();
    svc.configure(prisma, launcher);
    const r = await svc.tickOnce();
    expect(r.pairsLaunched).toBe(3);
    expect(launcher._starts).toHaveLength(3);
    // category в одном из 4 разрешённых.
    for (const s of launcher._starts) {
      expect(['bullet', 'blitz', 'rapid', 'classical']).toContain(s.category);
    }
  });

  it('completed = N synthetic users with >= target games (resume via DB)', async () => {
    // 2 synthetic уже сыграли по 5 партий между собой (cap PAIR_MAX_REPEAT=3
    // позволяет 3, поэтому добавим ещё одну пару — u0/u2).
    const games: FakeGame[] = [];
    for (let i = 0; i < 3; i++) games.push({ whiteId: 'u0', blackId: 'u1' });
    for (let i = 0; i < 2; i++) games.push({ whiteId: 'u0', blackId: 'u2' });
    for (let i = 0; i < 3; i++) games.push({ whiteId: 'u1', blackId: 'u3' });
    const prisma = makePrisma({ users: makeUsers(4), games });
    const launcher = makeLauncher();
    process.env.SYNTHETIC_BOOTSTRAP_PARALLELISM = '0';
    const svc = new SyntheticBootstrapService();
    svc.configure(prisma, launcher);
    const r = await svc.tickOnce();
    // u0 сыграл 3+2=5 → done. u1 = 3+3=6 → done. u2 = 2 → нет. u3 = 3 → нет.
    expect(r.progress.completed).toBe(2);
    expect(r.progress.totalSynthetics).toBe(4);
    expect(r.progress.done).toBe(false);
    expect(launcher._starts).toHaveLength(0); // parallel=0
  });

  it('all synthetic users reached target → done=true', async () => {
    const games: FakeGame[] = [];
    // 4 synthetic'а, каждый играет 5 партий с разными партнёрами,
    // соблюдая лимит ≤3 повторений.
    games.push(
      { whiteId: 'u0', blackId: 'u1' },
      { whiteId: 'u0', blackId: 'u1' },
      { whiteId: 'u0', blackId: 'u1' },
      { whiteId: 'u0', blackId: 'u2' },
      { whiteId: 'u0', blackId: 'u3' },
      { whiteId: 'u1', blackId: 'u2' },
      { whiteId: 'u1', blackId: 'u2' },
      { whiteId: 'u2', blackId: 'u3' },
      { whiteId: 'u2', blackId: 'u3' },
      { whiteId: 'u3', blackId: 'u1' },
      { whiteId: 'u3', blackId: 'u1' },
    );
    const prisma = makePrisma({ users: makeUsers(4), games });
    const launcher = makeLauncher();
    process.env.SYNTHETIC_BOOTSTRAP_PARALLELISM = '0';
    const svc = new SyntheticBootstrapService();
    svc.configure(prisma, launcher);
    const r = await svc.tickOnce();
    expect(r.progress.completed).toBe(4);
    expect(r.progress.done).toBe(true);
  });

  it('rating ±150: u0=1500, u_far=1700 → не пара (но u_close=1600 — пара)', async () => {
    const users: FakeUser[] = [
      { id: 'u0', ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      { id: 'u_close', ratingBullet: 1600, ratingBlitz: 1600, ratingRapid: 1600, ratingClassical: 1600 },
      { id: 'u_far', ratingBullet: 1700, ratingBlitz: 1700, ratingRapid: 1700, ratingClassical: 1700 },
    ];
    process.env.SYNTHETIC_BOOTSTRAP_PARALLELISM = '1';
    const prisma = makePrisma({ users });
    const launcher = makeLauncher();
    const svc = new SyntheticBootstrapService();
    svc.configure(prisma, launcher);
    await svc.tickOnce();
    expect(launcher._starts).toHaveLength(1);
    const s = launcher._starts[0];
    expect([s.whiteId, s.blackId]).toContain('u0');
    expect([s.whiteId, s.blackId]).toContain('u_close');
    expect([s.whiteId, s.blackId]).not.toContain('u_far');
  });

  it('targetGames из env подтягивается', async () => {
    process.env[require('@kingside/shared').SyntheticEnvKey.BootstrapTargetGames] = '99';
    const svc = new SyntheticBootstrapService();
    expect(svc.targetGames()).toBe(99);
  });
});
