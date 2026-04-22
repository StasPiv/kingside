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
    };
  };

  beforeEach(() => {
    prisma = {
      archiveSource: {
        findUnique: jest.fn(),
        create: jest.fn(),
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

    expect(result).toEqual({ created: 1, kept: 0 });
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
  });

  it('does NOT overwrite existing record (operator edits preserved)', async () => {
    prisma.archiveSource.findUnique.mockResolvedValue({ id: 'existing-uuid' });

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

    expect(result).toEqual({ created: 0, kept: 1 });
    expect(prisma.archiveSource.create).not.toHaveBeenCalled();
  });

  it('processes multiple seeds in order, mixed create+keep', async () => {
    prisma.archiveSource.findUnique
      .mockResolvedValueOnce(null) // twic — создаётся
      .mockResolvedValueOnce({ id: 'x' }); // hypothetical-other — существует
    prisma.archiveSource.create.mockResolvedValue({});

    const result = await service.ensureDefaults([
      { code: 'twic', kind: 'twic', name: 'TWIC', enabled: true, schedule: '0 */168 * * *', url: null },
      { code: 'lichess', kind: 'lichess', name: 'Lichess', enabled: true, schedule: '0 */24 * * *', url: null },
    ]);

    expect(result).toEqual({ created: 1, kept: 1 });
    expect(prisma.archiveSource.create).toHaveBeenCalledTimes(1);
    expect(prisma.archiveSource.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: 'twic' }) }),
    );
  });

  it('default list contains TWIC with weekly cron', () => {
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
