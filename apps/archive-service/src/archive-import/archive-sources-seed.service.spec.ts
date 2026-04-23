import {
  ArchiveSourcesSeedService,
  DEFAULT_ARCHIVE_SOURCES,
} from './archive-sources-seed.service';

describe('ArchiveSourcesSeedService', () => {
  let service: ArchiveSourcesSeedService;
  let prisma: {
    archiveSource: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      archiveSource: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new ArchiveSourcesSeedService(prisma as any);
  });

  it('creates record when code does not exist', async () => {
    prisma.archiveSource.findUnique.mockResolvedValue(null);
    prisma.archiveSource.create.mockResolvedValue({});

    const result = await service.ensureDefaults([
      {
        code: 'twic',
        kind: 'twic',
        name: 'The Week in Chess',
        enabled: true,
        schedule: '0 */168 * * *',
        url: 'https://theweekinchess.com/',
      },
    ]);

    expect(result).toEqual({ created: 1, kept: 0, healed: 0 });
    expect(prisma.archiveSource.create).toHaveBeenCalledWith({
      data: {
        code: 'twic',
        kind: 'twic',
        name: 'The Week in Chess',
        enabled: true,
        schedule: '0 */168 * * *',
        url: 'https://theweekinchess.com/',
      },
    });
    expect(prisma.archiveSource.update).not.toHaveBeenCalled();
  });

  it('keeps existing record untouched when enabled matches seed (operator edits preserved)', async () => {
    prisma.archiveSource.findUnique.mockResolvedValue({
      id: 'existing-uuid',
      enabled: true,
    });

    const result = await service.ensureDefaults([
      {
        code: 'twic',
        kind: 'twic',
        name: 'The Week in Chess',
        enabled: true,
        schedule: '0 */168 * * *',
        url: 'https://theweekinchess.com/',
      },
    ]);

    expect(result).toEqual({ created: 0, kept: 1, healed: 0 });
    expect(prisma.archiveSource.create).not.toHaveBeenCalled();
    expect(prisma.archiveSource.update).not.toHaveBeenCalled();
  });

  it('KS-1716 iter4: heals existing record when enabled=false but seed.enabled=true (catalog-metric fix)', async () => {
    // Реальный прод-сценарий (итерация 3 KS-1716): запись TWIC уже в БД,
    // но с enabled=false (от предыдущей версии кода / ручного SQL).
    // findMany({where:{enabled:true}}) возвращает пусто → catalog-emit
    // пустой → alarm A4 застревает в ALARM. Heal-up чинит это на любом
    // следующем invocation'е, без ручного SQL.
    prisma.archiveSource.findUnique.mockResolvedValue({
      id: 'existing-uuid',
      enabled: false,
    });
    prisma.archiveSource.update.mockResolvedValue({});

    const result = await service.ensureDefaults([
      {
        code: 'twic',
        kind: 'twic',
        name: 'The Week in Chess',
        enabled: true,
        schedule: '0 */168 * * *',
        url: 'https://theweekinchess.com/',
      },
    ]);

    expect(result).toEqual({ created: 0, kept: 1, healed: 1 });
    expect(prisma.archiveSource.create).not.toHaveBeenCalled();
    expect(prisma.archiveSource.update).toHaveBeenCalledTimes(1);
    expect(prisma.archiveSource.update).toHaveBeenCalledWith({
      where: { id: 'existing-uuid' },
      data: { enabled: true },
    });
  });

  it('heal is unidirectional (false→true only): seed.enabled=false on existing enabled=true → NOT disabled', async () => {
    // Оператор вручную включил источник, который в defaults помечен
    // enabled=false — это валидная оператор-правка, heal-up НЕ должен
    // её откатывать. Семантика heal-up — «дотянуть до seed-default»
    // только для случая, когда defaults хотят источник включённым,
    // но он в БД отключён.
    prisma.archiveSource.findUnique.mockResolvedValue({
      id: 'existing-uuid',
      enabled: true,
    });

    const result = await service.ensureDefaults([
      {
        code: 'deprecated',
        kind: 'twic',
        name: 'Deprecated',
        enabled: false,
        schedule: '0 */168 * * *',
        url: null,
      },
    ]);

    expect(result).toEqual({ created: 0, kept: 1, healed: 0 });
    expect(prisma.archiveSource.update).not.toHaveBeenCalled();
  });

  it('does NOT modify schedule/url/name/kind/cursor on existing record (operator edits preserved)', async () => {
    // В существующей записи enabled=true, schedule оператором изменён на
    // `*/5 * * * *`. Seed объявляет `0 */168 * * *`. Heal НЕ должен
    // касаться schedule — только enabled (которое здесь тоже совпадает,
    // update вообще не дёргается).
    prisma.archiveSource.findUnique.mockResolvedValue({
      id: 'existing-uuid',
      enabled: true,
    });

    await service.ensureDefaults([
      {
        code: 'twic',
        kind: 'twic',
        name: 'TWIC',
        enabled: true,
        schedule: '0 */168 * * *',
        url: 'https://theweekinchess.com/',
      },
    ]);

    expect(prisma.archiveSource.update).not.toHaveBeenCalled();
  });

  it('processes multiple seeds in order, mixed create+keep+heal', async () => {
    prisma.archiveSource.findUnique
      .mockResolvedValueOnce(null) // twic — создаётся
      .mockResolvedValueOnce({ id: 'x', enabled: false }) // lichess — heal
      .mockResolvedValueOnce({ id: 'y', enabled: true }); // other — kept
    prisma.archiveSource.create.mockResolvedValue({});
    prisma.archiveSource.update.mockResolvedValue({});

    const result = await service.ensureDefaults([
      { code: 'twic', kind: 'twic', name: 'TWIC', enabled: true, schedule: '0 */168 * * *', url: null },
      { code: 'lichess', kind: 'lichess', name: 'Lichess', enabled: true, schedule: '0 */24 * * *', url: null },
      { code: 'other', kind: 'twic', name: 'Other', enabled: true, schedule: '0 */24 * * *', url: null },
    ]);

    expect(result).toEqual({ created: 1, kept: 2, healed: 1 });
    expect(prisma.archiveSource.create).toHaveBeenCalledTimes(1);
    expect(prisma.archiveSource.update).toHaveBeenCalledTimes(1);
    expect(prisma.archiveSource.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: 'twic' }) }),
    );
    expect(prisma.archiveSource.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'x' } }),
    );
  });

  it('default list contains TWIC with weekly cron and enabled=true', () => {
    const twic = DEFAULT_ARCHIVE_SOURCES.find((s) => s.code === 'twic');
    expect(twic).toBeDefined();
    expect(twic?.enabled).toBe(true);
    expect(twic?.kind).toBe('twic');
    // 168 часов = 1 неделя, формат поддерживается intervalFromSchedule MVP.
    expect(twic?.schedule).toBe('0 */168 * * *');
  });

  it('propagates prisma errors (no swallowing)', async () => {
    prisma.archiveSource.findUnique.mockRejectedValue(new Error('conn refused'));

    await expect(
      service.ensureDefaults([
        { code: 'twic', kind: 'twic', name: 'TWIC', enabled: true, schedule: '0 */168 * * *', url: null },
      ]),
    ).rejects.toThrow('conn refused');
  });
});
