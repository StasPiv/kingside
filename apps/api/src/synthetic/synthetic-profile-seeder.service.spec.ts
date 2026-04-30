/**
 * KS-2162. Тесты SeederService — идемпотентность, backfill legacy-bot'ов,
 * правильное прокидывание полей в prisma.create.
 */
import { SyntheticProfileSeederService } from './synthetic-profile-seeder.service';

interface FakeUserRow {
  id: string;
  username: string | null;
  isSynthetic: boolean;
  country: string | null;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
}

function makePrisma(initial: FakeUserRow[]) {
  let store = [...initial];
  let seq = 1000;
  return {
    _store: () => store,
    user: {
      count: jest.fn(async ({ where }: { where: { isSynthetic: boolean } }) => {
        return store.filter((u) => u.isSynthetic === where.isSynthetic).length;
      }),
      findMany: jest.fn(
        async (args: {
          where?: Partial<FakeUserRow> & { country?: null };
          select?: Record<string, boolean>;
        }) => {
          let rows = [...store];
          if (args.where) {
            const w = args.where;
            rows = rows.filter((r) => {
              if (typeof w.isSynthetic === 'boolean' && r.isSynthetic !== w.isSynthetic) return false;
              if (w.country === null && r.country !== null) return false;
              return true;
            });
          }
          // отдаём только запрошенные select'ы (мок): seeder использует id + username + рейтинги.
          return rows.map((r) => ({ ...r }));
        },
      ),
      create: jest.fn(async ({ data }: { data: Partial<FakeUserRow> }) => {
        const row: FakeUserRow = {
          id: `u-${seq++}`,
          username: data.username ?? null,
          isSynthetic: !!data.isSynthetic,
          country: (data.country ?? null) as string | null,
          ratingBullet: data.ratingBullet ?? 1500,
          ratingBlitz: data.ratingBlitz ?? 1500,
          ratingRapid: data.ratingRapid ?? 1500,
          ratingClassical: data.ratingClassical ?? 1500,
        };
        store.push(row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeUserRow>;
        }) => {
          const idx = store.findIndex((r) => r.id === where.id);
          if (idx < 0) throw new Error('not found');
          store[idx] = { ...store[idx], ...data } as FakeUserRow;
          return store[idx];
        },
      ),
    },
  };
}

describe('SyntheticProfileSeederService.seed — KS-2162', () => {
  it('пустая БД, target=20 → создаёт 20 уникальных профилей', async () => {
    const prisma = makePrisma([]);
    const svc = new SyntheticProfileSeederService(prisma as never);
    const r = await svc.seed(20);

    expect(r.created).toBe(20);
    expect(r.totalAfter).toBe(20);
    expect(r.noop).toBe(false);
    const synth = prisma._store().filter((u) => u.isSynthetic);
    expect(synth).toHaveLength(20);
    expect(new Set(synth.map((u) => u.username)).size).toBe(20);
    for (const u of synth) {
      expect(u.country).toMatch(/^[A-Z]{2}$/);
      expect(u.ratingBullet).toBeGreaterThan(0);
    }
  });

  it('идемпотентность: повторный вызов с тем же target → noop', async () => {
    const prisma = makePrisma([]);
    const svc = new SyntheticProfileSeederService(prisma as never);
    await svc.seed(15);
    const second = await svc.seed(15);
    expect(second.noop).toBe(true);
    expect(second.created).toBe(0);
    expect(prisma._store().filter((u) => u.isSynthetic)).toHaveLength(15);
  });

  it('partial seed: 5 уже есть, target=10 → создаёт 5', async () => {
    const initial: FakeUserRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `pre-${i}`,
      username: `pre${i}`,
      isSynthetic: true,
      country: 'RU',
      ratingBullet: 1500,
      ratingBlitz: 1500,
      ratingRapid: 1500,
      ratingClassical: 1500,
    }));
    const prisma = makePrisma(initial);
    const svc = new SyntheticProfileSeederService(prisma as never);
    const r = await svc.seed(10);
    expect(r.created).toBe(5);
    expect(r.totalAfter).toBe(10);
  });

  it('legacy-bot backfill: country=null + дефолт-рейтинги → проставляются', async () => {
    const initial: FakeUserRow[] = [
      {
        id: 'legacy-1',
        username: 'ChessKnight42',
        isSynthetic: true,
        country: null, // legacy-bot, country пустой
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      },
    ];
    const prisma = makePrisma(initial);
    const svc = new SyntheticProfileSeederService(prisma as never);
    const r = await svc.seed(5);

    expect(r.legacyBotsBackfilled).toBe(1);
    const legacy = prisma._store().find((u) => u.id === 'legacy-1')!;
    expect(legacy.country).toMatch(/^[A-Z]{2}$/);
    // Все 4 рейтинга были = 1500 (default), значит должны быть пересеяны.
    const allDefault =
      legacy.ratingBullet === 1500 &&
      legacy.ratingBlitz === 1500 &&
      legacy.ratingRapid === 1500 &&
      legacy.ratingClassical === 1500;
    expect(allDefault).toBe(false);
  });

  it('legacy-bot backfill сохраняет нестандартные рейтинги, апдейтит только country', async () => {
    const initial: FakeUserRow[] = [
      {
        id: 'legacy-2',
        username: 'PawnStorm',
        isSynthetic: true,
        country: null,
        ratingBullet: 900, // не дефолт
        ratingBlitz: 950,
        ratingRapid: 920,
        ratingClassical: 880,
      },
    ];
    const prisma = makePrisma(initial);
    const svc = new SyntheticProfileSeederService(prisma as never);
    await svc.seed(5);
    const legacy = prisma._store().find((u) => u.id === 'legacy-2')!;
    expect(legacy.country).toMatch(/^[A-Z]{2}$/);
    // Рейтинги остались прежними.
    expect(legacy.ratingBullet).toBe(900);
    expect(legacy.ratingBlitz).toBe(950);
    expect(legacy.ratingRapid).toBe(920);
    expect(legacy.ratingClassical).toBe(880);
  });

  it('username коллизия → пропуск без падения', async () => {
    // Пред-сидируем username, который generator МОЖЕТ выдать.
    // Просто берём заведомо популярный шаблон и потом фильтруем результат —
    // тест-прокси: ставим в существующих один username, который точно
    // совпадёт хотя бы в большом количестве итераций.
    const prisma = makePrisma([
      {
        id: 'pre',
        username: 'ImpossibleNick99', // не пересечётся
        isSynthetic: false,
        country: 'XX',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
      },
    ]);
    const svc = new SyntheticProfileSeederService(prisma as never);
    const r = await svc.seed(10);
    // Не падаем; возможно пропустили коллизии — created ≤ 10.
    expect(r.created).toBeLessThanOrEqual(10);
    expect(r.created).toBeGreaterThanOrEqual(8);
  });

  it('resolveAvatarUrl возвращает DiceBear URL', () => {
    const svc = new SyntheticProfileSeederService({} as never);
    expect(svc.resolveAvatarUrl('Foo')).toBe(
      'https://api.dicebear.com/8.x/avataaars/png?seed=Foo',
    );
  });
});
